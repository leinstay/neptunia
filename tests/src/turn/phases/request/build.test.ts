import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createFakeAdapter } from '../../../../../scripts/lib/fake.ts';
import { fill } from '../../../../../src/format.ts';
import '../../../../../src/tools/operations/index.ts';
import { blockOf, TEXT as FRAME_TEXT, frameTurn, gistOf, partOf } from '../../../../fixtures/diary-frame.ts';
import {
  entriesPart,
  historyMemory,
  type HistoryMemory,
  historyRunner,
  historyWorld,
} from '../../../../fixtures/diary-history.ts';
import { NOW, ROOT, sceneLlm } from '../../../../fixtures/diary-requests-recorded.ts';
import type { SceneMemory } from '../../../../fixtures/diary-scene.ts';
import {
  addLine,
  addPerson,
  addRoom,
  deny,
  personNode,
  rootId,
  type World,
} from '../../../../fixtures/memory-db/mind-world.ts';
import {
  C1_CHAT,
  describeSubject,
  heartbeatWorld,
  blockOf as innerTurnServiceBlockOf,
  replyRun,
  blockOf as replyTurnMemoryBlockOf,
  replyTurns,
  rootTags,
  SEED_FAMILIES,
  seedLines,
  type ServiceRun,
  serviceTurn,
  serviceWake,
  serviceWorld,
  TURN_NOW,
} from '../../../../fixtures/service-turn.ts';
import { shippedLabels } from '../../../../fixtures/shipped-labels.ts';
import { skillTurn } from '../../../../fixtures/skill-tool-turns.ts';
import { skillsRig, type SkillsRig, skillText } from '../../../../fixtures/skills-rig.ts';
import { call, toolAnswer } from '../../../../fixtures/tool-answers.ts';
import { useIface, useSelf } from '../../../../fixtures/turn-world.ts';

/** The scenes of the tests, closed when the file is done. */
const HISTORIES: Array<HistoryMemory> = [];

after(async () => {
  for (const scene of HISTORIES.splice(0)) await scene.memory.close();
});

/** The writer's `<diary>` of the history scene's turn; `port` replaces the world's interface. */
async function writerEntries(port: ReturnType<typeof createFakeAdapter> | null = null): Promise<string> {
  const scene = await historyMemory();
  HISTORIES.push(scene);
  // The interface knows the diary channel with Alice's line in it: it is there, and it is not the persona's.
  historyWorld({ history: true, alice: true });
  const llm = sceneLlm();
  const result = await historyRunner(llm, scene, port).runTurn({
    mode: 'diary',
    diary: { kind: null, forced: false },
    placeId: ROOT,
  });
  assert.equal((result as { outcome?: unknown }).outcome, 'spoke', 'the scene records an entry');
  return entriesPart(llm);
}

test("with no interface connected the writer's <diary> is the same, because it comes from memory", async () => {
  // Bug: the entries are read through the interface, so a turn with nothing connected writes without the persona's diary.
  // Slice 6: the same scene read through `<diary>` instead of the diary channel's `<chat>`.
  // An interface that answers no read and takes no action: what a turn has when nothing is connected.
  const silent = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW, reads: [], operations: [] });
  const connected = await writerEntries();
  assert.ok(connected !== '', 'the connected turn shows the diary entries');
  assert.equal(await writerEntries(silent), connected);
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

  test('<diary> reads no mirror place', async () => {
    // Bug: the entries are rebuilt from the mirror's history, through the interface or from the persona's stored lines there.
    const run = await frameTurn({ entries: 3 });
    const block = partOf(blockOf(run.writer[0] ?? '', 'inner'), 'diary');
    assert.ok(block.includes(gistOf(2)), block);
    assert.ok(!block.includes(FRAME_TEXT.mirrorOnly), block);
    const { port } = run;
    const reads = port.calls.filter((one: { op: string }) => one.op === 'history' || one.op === 'fetchMessages');
    assert.deepEqual(reads, []);
  });

  test('two diary requests with nothing stored between them hold the same <kind> and <diary>', async () => {
    // Bug: something per request (a clock, a draw, an unordered set) enters the list and breaks the cache.
    // The persona's answer skips, so the first turn stores nothing for the second to read.
    const run = await frameTurn({ entries: 6, answer: '<skip/>', turns: 2 });
    assert.equal(run.writer.length, 2, 'one request per turn');
    const [first = '', second = ''] = run.writer.map((text) => blockOf(text, 'inner'));
    assert.equal(partOf(first, 'kind'), 'thought');
    assert.equal(partOf(second, 'kind'), partOf(first, 'kind'));
    assert.notEqual(partOf(first, 'diary'), '');
    assert.equal(partOf(second, 'diary'), partOf(first, 'diary'));
  });

  test('the diary requests are the same bytes with a heartbeat seeds file beside them', async () => {
    // Bug: the heartbeat's fragments or its lists leak into a diary request, which shares the heartbeat's path nowhere.
    const plain = await frameTurn();
    const seeded = await frameTurn({
      prompts: { 'heartbeat/seeds/one': 'ΘΡΑΥΣΜΑ-ΕΝΑ', 'heartbeat/seeds/two': 'ΘΡΑΥΣΜΑ-ΔΥΟ' },
    });
    assert.equal(seeded.writer[0], plain.writer[0]);
    assert.ok(!(seeded.writer[0] ?? '').includes('ΘΡΑΥΣΜΑ'));
  });
});

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

describe('a due intention in a turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('a placeless wake due for an intention that names a stored person shows that person in <people>', async () => {
    // Catches: the extra seed is added on the path of a turn with a place only, so an intention with no destination, the
    // turn that most needs its text read, still wakes the persona with no entry of the person it is about.
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
    // the persona addresses them by guesswork (the wrong gender of 2026-11-15).
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
});

/** A seeded random source in [0, 1) (mulberry32), so two runs with one seed draw alike. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The heartbeat's first request over the heartbeat world. */
async function heartbeatRequest(spec: { rng?: () => number; extraPeople?: number } = {}): Promise<string> {
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: ['<skip/>'],
    chat: null,
    world: heartbeatWorld({ extraPeople: spec.extraPeople ?? 0 }),
    ...(spec.rng ? { rng: spec.rng } : {}),
  });
  return run.requests[0] ?? '';
}

/** The lines of a subtag of `<memory>`. */
const subtagLines = (text: string, tag: string): Array<string> =>
  (new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(innerTurnServiceBlockOf(text, 'memory'))?.[1] ?? '').split(
    '\n'
  );

/** The entries of `<people>`, each with all its lines. */
const peopleEntries = (text: string): Array<string> =>
  (new RegExp('<people>\\n([\\s\\S]*?)\\n</people>').exec(innerTurnServiceBlockOf(text, 'memory'))?.[1] ?? '').split(
    '\n\n'
  );

/** The heartbeat world with `described` of `extra` more people holding a character and a manner of speech. */
function describedWorld(extra: number, described: number): ReturnType<typeof heartbeatWorld> {
  const world = heartbeatWorld({ extraPeople: extra });
  for (let i = 0; i < described; i += 1) {
    const id = `person:fake:9${String(i).padStart(3, '0')}`;
    describeSubject(world, `desc:char:${i}`, 'person', id, 'character', `ΧΑΡΑΚΤΗΡΑΣ-${i}`);
    describeSubject(world, `desc:style:${i}`, 'person', id, 'style', `ΤΡΟΠΟΣ-${i}`);
  }
  return world;
}

const carrying = (text: string, marker: string): Array<string> =>
  peopleEntries(text).filter((entry) => entry.includes(marker));

describe('an inner turn of a service', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('a heartbeat draws its lists and fragments with the turn rng: one seed one order, no family name', async () => {
    // Bug: the lists come in a fixed rank the persona reads as an order of preference, or the draw ignores the injected rng.
    const first = await heartbeatRequest({ rng: seeded(7), extraPeople: 8 });
    const again = await heartbeatRequest({ rng: seeded(7), extraPeople: 8 });
    const other = await heartbeatRequest({ rng: seeded(8), extraPeople: 8 });
    assert.equal(innerTurnServiceBlockOf(first, 'memory'), innerTurnServiceBlockOf(again, 'memory'));
    assert.equal(innerTurnServiceBlockOf(first, 'fragments'), innerTurnServiceBlockOf(again, 'fragments'));
    assert.notEqual(subtagLines(first, 'people').join('\n'), subtagLines(other, 'people').join('\n'));
    const all = SEED_FAMILIES.flatMap((_, family) => seedLines(family));
    const drawn = all.filter((line) => innerTurnServiceBlockOf(first, 'fragments').includes(line));
    assert.equal(drawn.length, 4, innerTurnServiceBlockOf(first, 'fragments'));
    const families = new Set(drawn.map((line) => line.split('-')[1]));
    assert.equal(families.size, 2, drawn.join(' '));
    for (const name of SEED_FAMILIES) assert.ok(!first.includes(name), name);
  });

  test('a heartbeat with more people than the cap lists the cap and says how many are left out', async () => {
    // Bug: every person memory holds goes into the request whatever their number.
    const text = await heartbeatRequest({ extraPeople: 55 });
    const people = subtagLines(text, 'people');
    // Changed on purpose: the service collector lists at most 30 people, so 27 of the 57 known are left out.
    assert.equal(people.filter((line) => line.startsWith('@')).length, 30);
    // Ελένη, Νίκος and the 55 more: 57 known, 27 left out.
    assert.equal(people.at(-1), fill(shippedLabels.memory?.leftOut ?? '', { count: 27 }));
  });

  test('a heartbeat gives three of the people it lists their character and manner of speech, drawn with the turn rng', async () => {
    // Bug: every person listed carries them, which costs most of the request, or none does, or the draw is fixed.
    const draw = async (seed: number): Promise<Array<string>> => {
      const run = await serviceTurn({
        wake: serviceWake('heartbeat'),
        answers: ['<skip/>'],
        chat: null,
        world: describedWorld(8, 8),
        rng: seeded(seed),
      });
      const text = run.requests[0] ?? '';
      const withCharacter = carrying(text, 'ΧΑΡΑΚΤΗΡΑΣ-');
      assert.equal(withCharacter.length, 3, peopleEntries(text).join('\n\n'));
      assert.equal(carrying(text, 'ΤΡΟΠΟΣ-').length, 3);
      return withCharacter.map((entry) => /ΧΑΡΑΚΤΗΡΑΣ-\d+/.exec(entry)?.[0] ?? '').sort();
    };
    const seeds = [1, 2, 3, 4, 5];
    const drawn = new Set<string>();
    for (const seed of seeds) drawn.add((await draw(seed)).join(' '));
    assert.ok(drawn.size > 1, 'the draw changes with the seed');
    assert.deepEqual(await draw(1), await draw(1));
  });

  test('a heartbeat draws for character only people who have one while two of them do', async () => {
    // Bug: the draw takes three of everyone listed, so a person with nothing stored takes the place of one who has it.
    for (const seed of [1, 2, 3]) {
      const run = await serviceTurn({
        wake: serviceWake('heartbeat'),
        answers: ['<skip/>'],
        chat: null,
        world: describedWorld(8, 2),
        rng: seeded(seed),
      });
      assert.equal(carrying(run.requests[0] ?? '', 'ΧΑΡΑΚΤΗΡΑΣ-').length, 2);
    }
  });

  test('a heartbeat with more places than the cap lists sixty and says how many it leaves out', async () => {
    // Bug: every live chat goes into the request whatever their number.
    const world = heartbeatWorld();
    for (let i = 0; i < 70; i += 1)
      addRoom(world.db, { iface: 'fake', native: `r${i}`, root: rootId('fake', 'g1'), name: `δωμάτιο-${i}` });
    const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null, world });
    const places = subtagLines(run.requests[0] ?? '', 'places').filter((line) => line !== '');
    const foot = places.at(-1) ?? '';
    const left = Number(/\d+/.exec(foot)?.[0] ?? NaN);
    assert.equal(places.length - 1, 60, places.join('\n'));
    assert.equal(foot, fill(shippedLabels.memory?.leftOut ?? '', { count: left }));
    assert.ok(left > 10, foot);
  });

  test('a turn with no place that is no heartbeat draws nothing from the rng and lists nothing', async () => {
    // Bug: the heartbeat's lists or fragments leak into another kind of turn, or its draw moves another request's bytes.
    const one = await serviceTurn({
      wake: serviceWake('intention_due'),
      answers: ['<skip/>'],
      chat: null,
      world: heartbeatWorld(),
      rng: seeded(1),
    });
    const two = await serviceTurn({
      wake: serviceWake('intention_due'),
      answers: ['<skip/>'],
      chat: null,
      world: heartbeatWorld(),
      rng: seeded(2),
    });
    assert.equal(one.requests[0], two.requests[0]);
    assert.ok(rootTags(one.requests[0] ?? '').includes('meanwhile'));
    assert.ok(!rootTags(one.requests[0] ?? '').includes('fragments'));
  });
});

const MIN = 60_000;

const THINK = '<think>STEP 4. So: answer.</think>';

const SAY = `${THINK}<msg>γεια</msg>`;

const NIKOS = 'person:fake:4242';

const NIKOS_LINE = 'ΓΡΑΜΜΗ-ΣΤΟΝ-ΜΟΛΟ';

const iso = (at: number): string => new Date(at).toISOString();

/** The service world with Νίκος, who wrote one line in the room `μόλος` and nowhere else; the persona's line after theirs when `personaAfter`. */
function pierWorld({ personaAfter }: { personaAfter: boolean }): World {
  const world = serviceWorld();
  const pier = addRoom(world.db, { iface: 'fake', native: 'c9', root: rootId('fake', 'g1'), name: 'μόλος' });
  addPerson(world.db, { id: NIKOS, accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] }] });
  addLine(world.db, {
    id: 'p1',
    iface: 'fake',
    place: pier,
    author: 'fake:4242',
    text: NIKOS_LINE,
    at: iso(TURN_NOW - 21 * MIN),
  });
  if (personaAfter)
    addLine(world.db, {
      id: 'p2',
      iface: 'fake',
      place: pier,
      author: 'self',
      text: 'ΔΙΚΗ-ΤΗΣ-ΜΟΛΟΣ',
      at: iso(TURN_NOW - 20 * MIN),
    });
  return world;
}

/** The body of `<people>` in the `<memory>` of a request's user text, '' when absent. */
const replyTurnMemoryPeopleOf = (request: string | undefined): string =>
  /<people>([\s\S]*?)<\/people>/.exec(replyTurnMemoryBlockOf(request ?? '', 'memory'))?.[1] ?? '';

describe('memory in a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('the author of a line in <meanwhile> who wrote nothing in the chat has an entry in <people>', async () => {
    // Bug: the graph reader of a reply is seeded from the chat window alone, so the persona reads Νίκος's line beside their own in
    // another room and memory shows nobody of that name, and the persona guesses who wrote it from a display name.
    const world = pierWorld({ personaAfter: true });
    try {
      const [first = []] = await replyTurns({
        world,
        steps: [{ trigger: { id: 'r2', text: 'καλημέρα', at: TURN_NOW - MIN }, answers: [SAY] }],
      });
      assert.ok(
        replyTurnMemoryBlockOf(first[0] ?? '', 'meanwhile').includes(NIKOS_LINE),
        'the line of Νίκος stands in <meanwhile>'
      );
      assert.match(replyTurnMemoryPeopleOf(first[0]), /Νίκος/);
    } finally {
      world.close();
    }
  });

  test('the author of a line an earlier lookup in <recall> shows has an entry in <people>', async () => {
    // Bug: <recall> repeats what the persona read in the room of Νίκος, and the graph reader never takes those lines as seeds,
    // so the next turn shows the line of Νίκος and nothing memory holds about them.
    const world = pierWorld({ personaAfter: false });
    try {
      const [first = [], second = []] = await replyTurns({
        world,
        steps: [
          {
            trigger: { id: 'r2', text: 'τι γράφουν εκεί;', at: TURN_NOW - 3 * MIN },
            answers: [toolAnswer(THINK, [call('conversation.read', { place: 'μόλος', last: 10 })]), SAY],
          },
          { trigger: { id: 'r3', text: 'ευχαριστώ', at: TURN_NOW - MIN }, answers: [SAY] },
        ],
      });
      assert.doesNotMatch(replyTurnMemoryPeopleOf(first[0]), /Νίκος/, 'nothing of the first request raised Νίκος');
      assert.ok(
        replyTurnMemoryBlockOf(second[0] ?? '', 'recall').includes(NIKOS_LINE),
        'the line of Νίκος stands in <recall>'
      );
      assert.match(replyTurnMemoryPeopleOf(second[0]), /Νίκος/);
    } finally {
      world.close();
    }
  });
});

const BODY = 'Search first, then read the best hit and say where it came from.';

/** A rig with one active skill, `look-it-up`, which needs `web.search`. */
function withSkill(t: { after: (fn: () => void) => void }): SkillsRig {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', skillText('look-it-up', 'I check the web first', ['web.search'], BODY));
  rig.port.activate('look-it-up', 'agent:hand');
  return rig;
}

test('the tools array is byte-identical between a reply in a room, a reply on the command line and a heartbeat', async (t) => {
  // Bug: a turn kind that filters its own tools breaks the one cached prefix and says another thing about what the persona can do.
  const rig = withSkill(t);
  const room = await skillTurn({ kind: 'discord-reply', answers: ['ok'], skills: rig.port });
  const cli = await skillTurn({ kind: 'cli-reply', answers: ['ok'], skills: rig.port });
  const heartbeat = await skillTurn({ kind: 'heartbeat', answers: ['ok'], skills: rig.port });
  assert.ok(room.offered.includes('look-it-up'), 'the active skill is an entry of the array');
  assert.equal(cli.toolsJson, room.toolsJson);
  assert.equal(heartbeat.toolsJson, room.toolsJson);
});

test('a turn without the skill.read grant offers no skill entry', async (t) => {
  // Bug: the owner takes skill.read away and the persona's skills are still offered and run as reads.
  const rig = withSkill(t);
  const grants = ['conversation.read', 'memory.search', 'message.create', 'web.search', 'skill.run', 'skill.disable'];
  const run = await skillTurn({ kind: 'discord-reply', answers: ['ok'], skills: rig.port, grants });
  assert.ok(run.offered.includes('web_search'), 'the granted tools are offered');
  assert.equal(run.offered.includes('look-it-up'), false);
});
