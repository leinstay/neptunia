// Tests for src/turn/request/attitudes.ts: the words of the `<attitudes>` block of `<self>`. Signatures:
//   type AttitudeWords = { labels: Labels; who: (person: string) => string }
//   attitudesText(list: ReadonlyArray<StrongAttitude>, words: AttitudeWords): string
// The text has no tags: `attitudes.header`, then one `attitudes.line` per person in the order given, `{who}` from `who`
// and `{band}` the word of `affinity.bands` for the band of the score. Pure, so the tests hand it labels of their own.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { attitudesText } from '../../../../src/turn/request/attitudes.ts';
import type { AttitudeWords } from '../../../../src/turn/request/attitudes.ts';
import type { StrongAttitude } from '../../../../src/memory/db/frame-reads.ts';
import type { Labels } from '../../../../src/turn/request/types.ts';
import { shippedLabels } from '../../../fixtures/shipped-labels.ts';
import { handleOf } from '../../../../src/behavior/handles.ts';
import { addAttitude, addDm, addPerson, type World } from '../../../fixtures/memory-db/mind-world.ts';
import { addPlaceClaim, type PlaceClaim } from '../../../fixtures/memory-db/place-claims.ts';
import { OWNER_PERSON } from '../../../fixtures/owner-accounts.ts';
import {
  blockOf,
  ELENI,
  replyRun,
  type ReplyStep,
  serviceWorld,
  TURN_NOW,
  ZOE,
} from '../../../fixtures/service-turn.ts';
import { useIface } from '../../../fixtures/turn-world.ts';

const BANDS = {
  hostile: 'B-hostile',
  dislike: 'B-dislike',
  cool: 'B-cool',
  neutral: 'B-neutral',
  warm: 'B-warm',
  fond: 'B-fond',
  devoted: 'B-devoted',
};
const OWN_LABELS: Labels = {
  ...shippedLabels,
  affinity: { bands: BANDS },
  attitudes: { header: 'FELT:', line: '* {who} / {band}' },
};
const words = (over: Partial<AttitudeWords> = {}): AttitudeWords => ({
  labels: OWN_LABELS,
  who: (person) => `W(${person})`,
  ...over,
});
const at = (person: string, score: number): StrongAttitude => ({ person, score, at: '2026-11-05' });
const labelled = (attitudes: Labels['attitudes']): AttitudeWords => words({ labels: { ...OWN_LABELS, attitudes } });

test('the text is the header and one line per person in the order given', () => {
  // Bug: the list is sorted again (the read already ordered it), or the header or a line is lost.
  const text = attitudesText([at('p1', -30), at('p2', 70), at('p3', 10)], words());
  assert.deepEqual(text.split('\n'), ['FELT:', '* W(p1) / B-dislike', '* W(p2) / B-devoted', '* W(p3) / B-warm']);
});

test('{who} is what the words give for the person id, never the id', () => {
  // Bug: the line carries the stored person id, or a name of its own, where the request names the person by handle.
  const text = attitudesText([at('person:x:9', 40)], words({ who: () => '@uabc1: Nina' }));
  assert.deepEqual(text.split('\n')[1], '* @uabc1: Nina / B-fond');
});

test('the band word follows the score at each edge of the bands', () => {
  // Bug: an edge falls on the wrong side (the bands are <= -60, <= -25, <= -8, < 8, < 25, < 60, else devoted), or the
  // band is looked up by a label key that does not exist.
  const edges: Array<[number, string]> = [
    [-60, 'B-hostile'],
    [-59.9, 'B-dislike'],
    [-25, 'B-dislike'],
    [-24.9, 'B-cool'],
    [-8, 'B-cool'],
    [8, 'B-warm'],
    [24.9, 'B-warm'],
    [25, 'B-fond'],
    [59.9, 'B-fond'],
    [60, 'B-devoted'],
    [100, 'B-devoted'],
  ];
  const lines = attitudesText(
    edges.map(([score], index) => at(`p${index}`, score)),
    words()
  )
    .split('\n')
    .slice(1);
  assert.deepEqual(
    lines.map((line) => line.split(' / ')[1]),
    edges.map(([, band]) => band)
  );
});

test('an empty list gives an empty text, with no header', () => {
  // Bug: a header stands over no one.
  assert.equal(attitudesText([], words()), '');
});

test('a missing header gives an empty text', () => {
  // Bug: the block opens with the word "undefined" or an empty line, or the lines stand with no header.
  assert.equal(attitudesText([at('p1', 40)], labelled({ line: '* {who} / {band}' })), '');
});

test('a missing line label gives an empty text', () => {
  // Bug: a header stands over lines that are the string "undefined".
  assert.equal(attitudesText([at('p1', 40)], labelled({ header: 'FELT:' })), '');
});

const MIN = 60_000;

const SAY = '<think>STEP 4. So: answer.</think><msg>εντάξει</msg>';

const NIKOS = 'person:fake:4242';

const GROUP = { group: 'fake' } as const;

const HANDLE = /@u[0-9a-z]+/;

/** The service world, with Νίκος, who wrote nothing anywhere, and the owner with a command line chat. */
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

const trigger = (id: string, at: number) => ({ id, text: 'καλημέρα', at });

const turn = (id: string, ago: number, before?: () => void): ReplyStep => ({
  ...(before === undefined ? {} : { before }),
  trigger: trigger(id, TURN_NOW - ago * MIN),
  answers: [SAY],
});

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

/** The entries of `<people>`, one text each. */
const peopleOf = (request: string): Array<string> =>
  (/<people>\n?([\s\S]*?)\n?<\/people>/.exec(blockOf(request, 'memory'))?.[1] ?? '')
    .split(/\n\s*\n/)
    .filter((entry) => entry.trim() !== '');

const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

// ---- C. the block <attitudes> ------------------------------------------------------------------------------------
// The people the persona feels most strongly about: `<attitudes>` inside `<self>`
// after `<lessons>`, at most `context.attitudes.shown` of them, the person they answer and the people of `<people>`
// included, each by the handle and the name the rest of the request uses.

const FELT = (shown: number): Record<string, unknown> => ({ lessons: { budgetTokens: 100_000 }, attitudes: { shown } });

/** The setup of a world: one change of the persona's attitude toward each person, the score after it, under the groups of `fake`. */
const feelings =
  (scores: ReadonlyArray<[string, number]>, audience: Parameters<typeof addAttitude>[1]['audience'] = GROUP) =>
  (world: World): void => {
    for (const [person, score] of scores) {
      addAttitude(world.db, {
        id: `aff:${person}`,
        person,
        at: '2026-10-30T10:00:00.000Z',
        applied: score,
        score,
        reason: null,
        audience,
      });
    }
  };

/** The body of `<attitudes>` inside `<self>`, '' when absent. */
const attitudesOf = (request: string): string =>
  /<attitudes>\n?([\s\S]*?)\n?<\/attitudes>/.exec(blockOf(request, 'self'))?.[1] ?? '';

const handleIn = (person: string): string => `@${handleOf(person)}`;

describe('lessons in a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('context.attitudes.shown at 0 gives no block, and the same world with 6 gives one', async () => {
    // Bug: the setting is not read (the block shows whatever it says), or 0 reads as a missing setting and falls back to a
    // default number.
    const setup = feelings([[NIKOS, 50]]);
    const [on = ''] = await inRoom([], [turn('r2', 1)], FELT(6), setup);
    const [off = ''] = await inRoom([], [turn('r2', 1)], FELT(0), setup);
    assert.match(attitudesOf(on), /Νίκος/);
    assert.doesNotMatch(off, /<attitudes>/);
  });

  test('context.attitudes.shown is the number of people listed, the strongest of them', async () => {
    // Bug: the number is fixed in the code and the setting changes nothing: of three people, two are listed.
    const [request = ''] = await inRoom(
      [],
      [turn('r2', 1)],
      FELT(2),
      feelings([
        [NIKOS, 20],
        [ZOE, -70],
        [ELENI, 45],
      ])
    );
    const body = attitudesOf(request);
    assert.ok(body.includes(handleIn(ZOE)) && body.includes(handleIn(ELENI)), body);
    assert.ok(!body.includes(handleIn(NIKOS)), body);
  });

  test('a listed person reads as the handle and the name the rest of the request uses, with or without an entry', async () => {
    // Bug: the line names the person by the stored id or a platform id, or by a handle another block does not use. Ελένη
    // wrote in the chat and has an entry in <people>, Νίκος wrote nothing and has none: the line declares Νίκος itself.
    const [request = ''] = await inRoom(
      [],
      [turn('r2', 1)],
      FELT(6),
      feelings([
        [NIKOS, 50],
        [ELENI, -40],
      ])
    );
    const body = attitudesOf(request);
    const entry = peopleOf(request).find((one) => one.includes('Ελένη')) ?? '';
    const eleni = HANDLE.exec(entry.split('\n')[0] ?? '')?.[0] ?? '';
    assert.match(eleni, HANDLE, 'Ελένη has an entry in <people>');
    assert.ok(lineWith(body, 'Ελένη').includes(eleni), body);
    assert.ok(lineWith(body, 'Νίκος').includes(handleIn(NIKOS)), body);
    assert.doesNotMatch(body, /person:|fake:/);
  });

  test('two requests with nothing stored between them hold the same bytes in <attitudes>, whoever the persona answers', async () => {
    // Bug: the block leaves out the person the persona answers or the people of <people>, so a turn that answers someone else
    // lists other people, <self> changes bytes and the cached prefix is rewritten.
    const toZoe = { ...trigger('r3', TURN_NOW - MIN), authorId: '5678', authorName: 'Ζωή' };
    const [first = '', second = ''] = await inRoom(
      [],
      [turn('r2', 3), { trigger: toZoe, answers: [SAY] }],
      FELT(6),
      feelings([
        [ELENI, 35],
        [ZOE, -45],
        [NIKOS, 60],
      ])
    );
    const body = attitudesOf(first);
    for (const person of [ELENI, ZOE, NIKOS]) assert.ok(body.includes(handleIn(person)), body);
    assert.equal(attitudesOf(second), body);
  });
});
