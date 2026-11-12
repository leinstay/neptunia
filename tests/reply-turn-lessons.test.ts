// The in-jokes of a root and her lessons in a request (spec 2026-11-12-what-the-frame-dropped, slice 1). The in-jokes stand
// in `<root>` of `<surroundings>` under `surroundings.fields.injokes`. What people taught her stands in a block `<lessons>`
// inside `<self>`, beside `<self_facts>`, from every place and every person the turn's context may read, each lesson
// naming its teacher by the `@handle` the teacher has in `<people>`, ranked as the old `<about_chat>` ranked them
// (src/memory/ranking.ts: log2(weight + 0.5) plus the moment last seen over 720 days) within `context.lessons.budgetTokens`.
// The labels are `lessons.header` and `lessons.line` (`{text}`, `{from}`); `surroundings.fields.lessons` is gone.
// Reply turns of the real turn runner over the service world (tests/fixtures/service-turn.ts#replyRun), claims of a place
// from tests/fixtures/memory-db/place-claims.ts, synthetic names. The facts are read off the request, never its wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDm, addPerson } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { addPlaceClaim } from './fixtures/memory-db/place-claims.ts';
import type { PlaceClaim } from './fixtures/memory-db/place-claims.ts';
import { OWNER_PERSON } from './fixtures/owner-accounts.ts';
import { useIface } from './fixtures/turn-world.ts';
import { CLI_CHAT, ELENI, TURN_NOW, ZOE, blockOf, replyRun, serviceWorld } from './fixtures/service-turn.ts';
import type { ReplyStep } from './fixtures/service-turn.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

useIface('fake');

const MIN = 60_000;
const SAY = '<think>STEP 4. So: answer.</think><msg>εντάξει</msg>';
const AGORA = 'fake:server:g1';
const ISLAND = 'tele:server:t1';
const ZOE_DM = 'fake:dm:5678';
const NIKOS = 'person:fake:4242';
const GROUP = { group: 'fake' } as const;
const HANDLE = /@u[0-9a-z]+/;
/** The label of an in-joke line of `<root>`, read off the labels as `fieldLines` reads it. */
const JOKES_LABEL = shippedLabels.surroundings?.fields?.injokes ?? 'injokes';

/** The service world, with Νίκος, who wrote nothing anywhere, and the owner with her command line chat. */
function lessonWorld(): World {
  const world = serviceWorld();
  addPerson(world.db, { id: NIKOS, accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] }] });
  addPerson(world.db, {
    id: OWNER_PERSON,
    accounts: [{ id: 'cli:owner', iface: 'cli', native: 'owner', names: ['Πέτρος'] }],
  });
  addDm(world.db, { iface: 'cli', native: 'owner', person: OWNER_PERSON, account: 'cli:owner' });
  return world;
}

const lesson = (id: string, text: string, over: Partial<PlaceClaim> = {}): PlaceClaim => ({
  id,
  place: AGORA,
  kind: 'lesson',
  text,
  audience: GROUP,
  ...over,
});
const joke = (id: string, text: string, over: Partial<PlaceClaim> = {}): PlaceClaim => ({
  ...lesson(id, text, over),
  kind: 'injoke',
});

const trigger = (id: string, at: number) => ({ id, text: 'καλημέρα', at });
const turn = (id: string, ago: number, before?: () => void): ReplyStep => ({
  ...(before === undefined ? {} : { before }),
  trigger: trigger(id, TURN_NOW - ago * MIN),
  answers: [SAY],
});
const retire = (world: World, id: string): void => {
  world.db.prepare('UPDATE claims SET retired_at = ? WHERE id = ?').run('2026-11-02T11:00:00.000Z', id);
};

/** The requests of reply turns in `c1` over a world holding `claims`, one text per turn. */
async function inRoom(
  claims: ReadonlyArray<PlaceClaim>,
  steps: ReadonlyArray<ReplyStep> = [turn('r2', 1)],
  context: Record<string, unknown> = { lessons: { budgetTokens: 100_000 } },
  setup: (world: World) => void = () => {}
): Promise<Array<string>> {
  const world = lessonWorld();
  try {
    for (const claim of claims) addPlaceClaim(world.db, claim);
    setup(world);
    const run = await replyRun({ world, steps, context });
    return run.requests.map((requests) => requests[0] ?? '');
  } finally {
    world.close();
  }
}

/** The body of `<lessons>` inside `<self>`, '' when absent. */
const lessonsOf = (request: string): string =>
  /<lessons>\n?([\s\S]*?)\n?<\/lessons>/.exec(blockOf(request, 'self'))?.[1] ?? '';
/** The body of `<root>` inside `<surroundings>`, '' when absent. */
const rootOf = (request: string): string =>
  /<root>\n?([\s\S]*?)\n?<\/root>/.exec(blockOf(request, 'surroundings'))?.[1] ?? '';
/** The entries of `<people>`, one text each. */
const peopleOf = (request: string): Array<string> =>
  (/<people>\n?([\s\S]*?)\n?<\/people>/.exec(blockOf(request, 'memory'))?.[1] ?? '')
    .split(/\n\s*\n/)
    .filter((entry) => entry.trim() !== '');
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

// ---- A. the in-jokes of the root ---------------------------------------------------------------------------------

test('a root with stored in-jokes reads them in <root> under the label of the in-jokes', async () => {
  // Bug: the request builder hands <root> the patterns and the starters only, so the in-jokes the labels name never show.
  const [request = ''] = await inRoom([joke('j1', 'ΑΣΤΕΙΟ-ΠΡΩΤΟ'), joke('j2', 'ΑΣΤΕΙΟ-ΔΕΥΤΕΡΟ')]);
  const line = lineWith(rootOf(request), 'ΑΣΤΕΙΟ-ΠΡΩΤΟ');
  assert.ok(line.startsWith(JOKES_LABEL), rootOf(request));
  assert.ok(line.includes('ΑΣΤΕΙΟ-ΔΕΥΤΕΡΟ'), line);
});

test('the in-jokes of another root do not show in <root>', async () => {
  // Bug: the in-jokes are read by kind alone, so every root's jokes land in the root of the turn.
  const [request = ''] = await inRoom([
    joke('j1', 'ΑΣΤΕΙΟ-ΑΓΟΡΑΣ'),
    joke('j2', 'ΑΣΤΕΙΟ-ΝΗΣΙΟΥ', { place: ISLAND, audience: { group: 'tele' } }),
  ]);
  assert.match(rootOf(request), /ΑΣΤΕΙΟ-ΑΓΟΡΑΣ/);
  assert.doesNotMatch(request, /ΑΣΤΕΙΟ-ΝΗΣΙΟΥ/);
});

test('a root whose in-jokes were retired has no in-joke line at the next turn', async () => {
  // Bug: the line stays with an empty value, or the retired joke stays in the request.
  const world = lessonWorld();
  try {
    addPlaceClaim(world.db, joke('j1', 'ΑΣΤΕΙΟ-ΠΡΩΤΟ'));
    const steps = [turn('r2', 3), turn('r3', 1, () => retire(world, 'j1'))];
    const run = await replyRun({ world, steps });
    const [first = '', second = ''] = run.requests.map((requests) => requests[0] ?? '');
    assert.match(rootOf(first), /ΑΣΤΕΙΟ-ΠΡΩΤΟ/);
    assert.doesNotMatch(rootOf(second), /ΑΣΤΕΙΟ-ΠΡΩΤΟ/);
    assert.ok(!rootOf(second).includes(JOKES_LABEL), rootOf(second));
  } finally {
    world.close();
  }
});

test('an in-joke under an audience the turn may not read does not show in a group', async () => {
  // Bug: the in-jokes are read without the turn's context, so a joke from a private chat shows in a room.
  const [request = ''] = await inRoom([
    joke('j1', 'ΑΣΤΕΙΟ-ΔΗΜΟΣΙΟ'),
    joke('j2', 'ΑΣΤΕΙΟ-ΙΔΙΩΤΙΚΟ', { audience: { dm: ZOE_DM, iface: 'fake', person: ZOE } }),
  ]);
  assert.match(rootOf(request), /ΑΣΤΕΙΟ-ΔΗΜΟΣΙΟ/);
  assert.doesNotMatch(request, /ΑΣΤΕΙΟ-ΙΔΙΩΤΙΚΟ/);
});

test('two requests with nothing stored between them hold the same bytes in <root>', async () => {
  // Bug: the in-jokes come back in an order that moves between reads, and the held <surroundings> changes bytes.
  const claims = ['ΑΣΤΕΙΟ-Α', 'ΑΣΤΕΙΟ-Β', 'ΑΣΤΕΙΟ-Γ', 'ΑΣΤΕΙΟ-Δ'].map((text, at) => joke(`j${at}`, text));
  const [first = '', second = ''] = await inRoom(claims, [turn('r2', 3), turn('r3', 1)]);
  assert.match(rootOf(first), /ΑΣΤΕΙΟ-Α/);
  assert.equal(rootOf(second), rootOf(first));
});

// ---- B. the block <lessons> --------------------------------------------------------------------------------------

test('<lessons> stands inside <self> and holds the lessons of this root and of another root', async () => {
  // Bug: the lessons stay in the root's fields (the old <about_chat> read the turn's root only), so a lesson learned under
  // another root never follows her.
  const [request = ''] = await inRoom([
    lesson('l1', 'ΜΑΘΗΜΑ-ΑΓΟΡΑΣ'),
    lesson('l2', 'ΜΑΘΗΜΑ-ΝΗΣΙΟΥ', { place: ISLAND, audience: { group: 'tele' } }),
  ]);
  const body = lessonsOf(request);
  assert.ok(body.includes('ΜΑΘΗΜΑ-ΑΓΟΡΑΣ') && body.includes('ΜΑΘΗΜΑ-ΝΗΣΙΟΥ'), body);
});

test('<lessons> shows on the command line, an interface with no root, the lessons of every root', async () => {
  // Bug: the block is read for the root of the turn's place, and a turn with no root reads nothing.
  const world = lessonWorld();
  try {
    addPlaceClaim(world.db, lesson('l1', 'ΜΑΘΗΜΑ-ΑΓΟΡΑΣ'));
    addPlaceClaim(world.db, lesson('l2', 'ΜΑΘΗΜΑ-ΝΗΣΙΟΥ', { place: ISLAND, audience: { group: 'tele' } }));
    const owner = { id: 'm1', text: 'καλημέρα', at: TURN_NOW - MIN, authorId: 'owner', authorName: 'owner' };
    const step: ReplyStep = { trigger: owner, answers: [SAY] };
    const run = await replyRun({
      world,
      chat: CLI_CHAT,
      steps: [step],
      context: { lessons: { budgetTokens: 100_000 } },
    });
    const body = lessonsOf(run.requests[0]?.[0] ?? '');
    assert.ok(body.includes('ΜΑΘΗΜΑ-ΑΓΟΡΑΣ') && body.includes('ΜΑΘΗΜΑ-ΝΗΣΙΟΥ'), body);
  } finally {
    world.close();
  }
});

test('a lesson under an audience the turn may not read does not show in a group', async () => {
  // Bug: the lessons are read without the turn's context, so what a person taught her in private shows in a room.
  const [request = ''] = await inRoom([
    lesson('l1', 'ΜΑΘΗΜΑ-ΔΗΜΟΣΙΟ'),
    lesson('l2', 'ΜΑΘΗΜΑ-ΙΔΙΩΤΙΚΟ', { place: ZOE_DM, audience: { dm: ZOE_DM, iface: 'fake', person: ZOE } }),
  ]);
  assert.match(lessonsOf(request), /ΜΑΘΗΜΑ-ΔΗΜΟΣΙΟ/);
  assert.doesNotMatch(request, /ΜΑΘΗΜΑ-ΙΔΙΩΤΙΚΟ/);
});

test('each lesson names its teacher by the handle the teacher has in <people>, and the teacher has an entry', async () => {
  // Bug: the lesson names a teacher by a platform id or a display name, or by a handle with no entry behind it, so she
  // cannot tell who taught her. Νίκος wrote nothing in the chat, Ελένη wrote in it.
  const [request = ''] = await inRoom([
    lesson('l1', 'ΜΑΘΗΜΑ-ΝΙΚΟΥ', { teacher: NIKOS, weight: 3 }),
    lesson('l2', 'ΜΑΘΗΜΑ-ΕΛΕΝΗΣ', { teacher: ELENI, weight: 2 }),
  ]);
  const body = lessonsOf(request);
  for (const [marker, name] of [
    ['ΜΑΘΗΜΑ-ΝΙΚΟΥ', 'Νίκος'],
    ['ΜΑΘΗΜΑ-ΕΛΕΝΗΣ', 'Ελένη'],
  ]) {
    const entry = peopleOf(request).find((one) => one.includes(name)) ?? '';
    const handle = HANDLE.exec(entry.split('\n')[0] ?? '')?.[0] ?? '';
    assert.match(handle, HANDLE, `${name} has an entry in <people>`);
    assert.ok(lineWith(body, marker).includes(handle), `${marker}: ${lineWith(body, marker)}`);
  }
  assert.doesNotMatch(body, /4242|111|person:/);
});

test('the lessons come in the order of weight with decayed recency, whatever the order of storage', async () => {
  // Bug: the lessons are sorted by weight alone, by recency alone or as stored. A: weight 5 seen 2026-11-01. B: weight 1
  // seen 2026-11-10. D: weight 1 seen 2026-10-01. C: weight 2 seen 2024-01-01. The old order is A, B, D, C.
  const put = (id: string, weight: number, seenAt: string) => lesson(id, `ΜΑΘΗΜΑ-${id}`, { weight, seenAt });
  const [request = ''] = await inRoom([
    put('D', 1, '2026-10-01T10:00:00.000Z'),
    put('C', 2, '2024-01-01T10:00:00.000Z'),
    put('A', 5, '2026-11-01T10:00:00.000Z'),
    put('B', 1, '2026-11-10T10:00:00.000Z'),
  ]);
  const body = lessonsOf(request);
  const at = ['A', 'B', 'D', 'C'].map((id) => body.indexOf(`ΜΑΘΗΜΑ-${id}`));
  assert.ok(
    at.every((index) => index >= 0),
    body
  );
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
    body
  );
});

test('a small context.lessons.budgetTokens leaves out the lowest ranked lessons and keeps the others in order', async () => {
  // Bug: the block ignores its own budget (or the self facts' cap stands in for it), or the cut keeps the wrong ones.
  // Each lesson is about 200 ASCII characters, 60 tokens a line: two fit in 160 tokens, three do not.
  const pad =
    ' lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore'.repeat(
      2
    );
  const put = (id: string, weight: number) => lesson(id, `LESSON-${id}${pad}`, { weight });
  const [request = ''] = await inRoom([put('D', 1), put('B', 5), put('A', 9), put('C', 3)], [turn('r2', 1)], {
    lessons: { budgetTokens: 160 },
  });
  const body = lessonsOf(request);
  assert.ok(body.indexOf('LESSON-A') >= 0 && body.indexOf('LESSON-B') > body.indexOf('LESSON-A'), body);
  assert.doesNotMatch(body, /LESSON-C|LESSON-D/);
});

test('a retired lesson leaves <lessons>, and the block leaves with the last one', async () => {
  // Bug: the block is kept with its header and no lines, or the retired lesson is held for ever.
  const world = lessonWorld();
  try {
    addPlaceClaim(world.db, lesson('l1', 'ΜΑΘΗΜΑ-ΠΡΩΤΟ'));
    const steps = [turn('r2', 3), turn('r3', 1, () => retire(world, 'l1'))];
    const run = await replyRun({ world, steps, context: { lessons: { budgetTokens: 100_000 } } });
    const [first = '', second = ''] = run.requests.map((requests) => requests[0] ?? '');
    assert.match(lessonsOf(first), /ΜΑΘΗΜΑ-ΠΡΩΤΟ/);
    assert.ok(!blockOf(second, 'self').includes('<lessons>'), blockOf(second, 'self'));
    assert.doesNotMatch(second, /ΜΑΘΗΜΑ-ΠΡΩΤΟ/);
  } finally {
    world.close();
  }
});

test('two requests with nothing stored between them hold the same bytes in <lessons>', async () => {
  // Bug: the block carries something that moves between turns (an order of equal ranks, a time), so <self> changes bytes
  // and the cached prefix is rewritten at every turn.
  const claims = ['Α', 'Β', 'Γ', 'Δ'].map((mark, at) =>
    lesson(`l${at}`, `ΜΑΘΗΜΑ-${mark}`, { teacher: at % 2 === 0 ? NIKOS : ELENI })
  );
  const [first = '', second = ''] = await inRoom(claims, [turn('r2', 3), turn('r3', 1)]);
  assert.match(lessonsOf(first), /ΜΑΘΗΜΑ-Α/);
  assert.equal(lessonsOf(second), lessonsOf(first));
});

test('<root> holds no lessons line', async () => {
  // Bug: the lessons stay in the fields of the root beside the block, so each shows twice.
  const [request = ''] = await inRoom([lesson('l1', 'ΜΑΘΗΜΑ-ΑΓΟΡΑΣ'), joke('j1', 'ΑΣΤΕΙΟ-ΑΓΟΡΑΣ')]);
  assert.match(lessonsOf(request), /ΜΑΘΗΜΑ-ΑΓΟΡΑΣ/);
  assert.match(rootOf(request), /ΑΣΤΕΙΟ-ΑΓΟΡΑΣ/);
  assert.doesNotMatch(rootOf(request), /ΜΑΘΗΜΑ-ΑΓΟΡΑΣ/);
});
