// Tests for src/memory/db/frame-reads.ts: what it reads of a place's claims and of the persona's attitudes for a request
// on the turn frame. Signatures:
//   lessonsOf(db: Db, ctx: Context): Array<Lesson>
//   type Lesson = { text: string; teacher: string | null }, `teacher` the person id that taught it (`from_person`)
//   placeFieldsOf(db, ctx, placeId) holds the field `injokes`: the in-jokes of the place the context reads, in one string
//   strongestAttitudesOf(db: Db, ctx: Context, limit: number): Array<StrongAttitude>, the people the persona feels
//     most strongly about
//   type StrongAttitude = { person: string; score: number; at: string }
// `lessonsOf` reads the claims of kind `lesson` of every place whose audience the context may read, retired ones left out,
// ranked by src/memory/ranking.ts `rank`: log2(weight + 0.5) plus the moment last seen over a half-life of 720 days
// (`memory.learnedHalfLifeDays`), the best first. Synthetic SQLite rows over the mind-world.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  lessonsOf,
  placeFieldsOf,
  strongestAttitudesOf,
  chatPlacesOf,
  lineOfIdentity,
  linesAroundOf,
  linesSinceOf,
  ownLinesOf,
  sourceRetiredOf,
  frameReadsOver,
} from '../../../../src/memory/db/frame-reads.ts';
import { dmContext, groupContext, internalContext } from '../../../../src/memory/db/scope.ts';
import {
  addAttitude,
  addDm,
  addPerson,
  noteInterface,
  openWorld,
  rootId,
  addLine,
  addRoom,
} from '../../../fixtures/memory-db/mind-world.ts';
import type { World } from '../../../fixtures/memory-db/mind-world.ts';
import type { Audience } from '../../../fixtures/memory-db/mind-world.ts';
import { addPlaceClaim, addSourceLine } from '../../../fixtures/memory-db/place-claims.ts';
import { insertRows } from '../../../../src/memory/db/rows.ts';
import { EDIT_DELAY_MS, minute, storeProductionEdit, storeRevision } from '../../../fixtures/memory-db/edited-line.ts';
import type { Db, Statement } from '../../../../src/memory/db/types.ts';
import { writeIntentions } from '../../../../src/memory/db/intentions-write.ts';
import { finishRun, startRun } from '../../../../src/memory/db/wakes.ts';
import { quantize } from '../../../../src/memory/vectors.ts';
import {
  TURN_NOW,
  serviceWorld,
  CLI_CHAT,
  ZOE as LESSONS_ZOE,
  blockOf,
  replyRun,
} from '../../../fixtures/service-turn.ts';
import { createEdits } from '../../../../src/pipeline/edits.ts';
import type { MessageEvent } from '../../../../src/pipeline/edits.ts';
import { createObserve } from '../../../../src/pipeline/observe.ts';
import type { Message } from '../../../../src/protocol/events.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import type { TestMemory } from '../../../fixtures/memory-db/service.ts';
import { rig } from '../../../fixtures/reads-rig.ts';
import type { PlaceClaim } from '../../../fixtures/memory-db/place-claims.ts';
import { handleOf } from '../../../../src/behavior/handles.ts';
import { OWNER_PERSON } from '../../../fixtures/owner-accounts.ts';
import { useIface } from '../../../fixtures/turn-world.ts';
import type { ReplyStep } from '../../../fixtures/service-turn.ts';
import { shippedLabels } from '../../../fixtures/shipped-labels.ts';

const AGORA = rootId('fake', 'g1');
const ISLAND = rootId('tele', 't1');
const ZOE = 'person:fake:5678';
const NIKOS = 'person:fake:4242';
const GROUP = { group: 'fake' } as const;

/** Two roots on two interfaces, and Zoe with a direct chat on `fake`. */
function lessonWorld(): { world: World; zoeDm: string } {
  const world = openWorld();
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  noteInterface(world, 'tele', [{ id: 't1', name: 'Island' }]);
  addPerson(world.db, { id: ZOE, accounts: [{ id: 'fake:5678', iface: 'fake', native: '5678', names: ['Zoe'] }] });
  const zoeDm = addDm(world.db, { iface: 'fake', native: '5678', person: ZOE, account: 'fake:5678' });
  return { world, zoeDm };
}

const texts = (lessons: ReadonlyArray<{ text: string }>): Array<string> => lessons.map((one) => one.text);

test('lessons come back ranked by weight and decayed recency, the way the old block ranked them', () => {
  // Bug: the reader sorts by weight alone, by recency alone or by the order of storage, so what people taught the
  // persona most often and lately is cut first when the budget runs out.
  // A: weight 5 seen 2026-11-01 (rank 2.46). B: weight 1 seen 2026-11-10 (0.60). D: weight 1 seen 2026-10-01 (0.54).
  // C: weight 2 seen 2024-01-01 (-0.12). By weight alone C would stand second, by recency alone B first.
  const { world } = lessonWorld();
  try {
    const put = (id: string, weight: number, seenAt: string) =>
      addPlaceClaim(world.db, { id, place: AGORA, kind: 'lesson', text: id, audience: GROUP, weight, seenAt });
    put('lesson-d', 1, '2026-10-01T10:00:00.000Z');
    put('lesson-c', 2, '2024-01-01T10:00:00.000Z');
    put('lesson-a', 5, '2026-11-01T10:00:00.000Z');
    put('lesson-b', 1, '2026-11-10T10:00:00.000Z');
    assert.deepEqual(texts(lessonsOf(world.db, groupContext('fake'))), [
      'lesson-a',
      'lesson-b',
      'lesson-d',
      'lesson-c',
    ]);
  } finally {
    world.close();
  }
});

test('lessons learned under another root and on another interface come back with the lessons of this one', () => {
  // Bug: the reader keeps to the root of the turn's place, so what a person taught the persona elsewhere never follows
  // them.
  const { world } = lessonWorld();
  try {
    addPlaceClaim(world.db, {
      id: 'l-here',
      place: AGORA,
      kind: 'lesson',
      text: 'taught here',
      audience: GROUP,
      weight: 3,
    });
    addPlaceClaim(world.db, {
      id: 'l-there',
      place: ISLAND,
      kind: 'lesson',
      text: 'taught there',
      audience: { group: 'tele' },
      weight: 2,
    });
    assert.deepEqual(texts(lessonsOf(world.db, groupContext('fake'))), ['taught here', 'taught there']);
  } finally {
    world.close();
  }
});

test('a lesson of a direct chat stays out of a group read', () => {
  // Bug: the reader takes every lesson whatever its audience, and a lesson taught in a private chat shows in a group.
  const { world, zoeDm } = lessonWorld();
  try {
    addPlaceClaim(world.db, {
      id: 'l-group',
      place: AGORA,
      kind: 'lesson',
      text: 'taught in the group',
      audience: GROUP,
      weight: 1,
    });
    addPlaceClaim(world.db, {
      id: 'l-private',
      place: zoeDm,
      kind: 'lesson',
      text: 'taught in private',
      audience: { dm: zoeDm, iface: 'fake', person: ZOE },
      weight: 9,
    });
    assert.deepEqual(texts(lessonsOf(world.db, groupContext('fake'))), ['taught in the group']);
  } finally {
    world.close();
  }
});

test('a direct chat reads its own lessons and the groups, and not the lessons of another direct chat', () => {
  // Bug: the reader drops everything but groups, so a lesson taught in a chat never comes back in that chat, or it reads
  // the lessons of every direct chat.
  const { world, zoeDm } = lessonWorld();
  try {
    addPerson(world.db, {
      id: NIKOS,
      accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Nikos'] }],
    });
    const nikosDm = addDm(world.db, { iface: 'fake', native: '4242', person: NIKOS, account: 'fake:4242' });
    addPlaceClaim(world.db, { id: 'l-group', place: AGORA, kind: 'lesson', text: 'group', audience: GROUP, weight: 1 });
    addPlaceClaim(world.db, {
      id: 'l-zoe',
      place: zoeDm,
      kind: 'lesson',
      text: 'zoe private',
      audience: { dm: zoeDm, iface: 'fake', person: ZOE },
      weight: 3,
    });
    addPlaceClaim(world.db, {
      id: 'l-nikos',
      place: nikosDm,
      kind: 'lesson',
      text: 'nikos private',
      audience: { dm: nikosDm, iface: 'fake', person: NIKOS },
      weight: 5,
    });
    const read = texts(lessonsOf(world.db, dmContext(ZOE, 'fake', zoeDm)));
    assert.deepEqual([...read].sort(), ['group', 'zoe private']);
  } finally {
    world.close();
  }
});

test('a lesson carries the person id of the person who taught it, and none when the row names nobody', () => {
  // Bug: the teacher is read as the stored mention text or dropped, so the request cannot name the person by handle.
  const { world } = lessonWorld();
  try {
    addPlaceClaim(world.db, {
      id: 'l-told',
      place: AGORA,
      kind: 'lesson',
      text: 'told',
      audience: GROUP,
      weight: 4,
      teacher: NIKOS,
    });
    addPlaceClaim(world.db, {
      id: 'l-anon',
      place: AGORA,
      kind: 'lesson',
      text: 'anon',
      audience: GROUP,
      weight: 2,
      teacher: null,
    });
    assert.deepEqual(
      lessonsOf(world.db, groupContext('fake')).map((one) => [one.text, one.teacher]),
      [
        ['told', NIKOS],
        ['anon', null],
      ]
    );
  } finally {
    world.close();
  }
});

test('a retired lesson and a claim of another kind do not come back', () => {
  // Bug: the reader takes claims of the place by subject and drops neither the retired lessons nor the in-jokes.
  const { world } = lessonWorld();
  try {
    addPlaceClaim(world.db, { id: 'l-live', place: AGORA, kind: 'lesson', text: 'live', audience: GROUP });
    addPlaceClaim(world.db, {
      id: 'l-old',
      place: AGORA,
      kind: 'lesson',
      text: 'retired',
      audience: GROUP,
      weight: 9,
      retiredAt: '2026-11-02T10:00:00.000Z',
    });
    addPlaceClaim(world.db, { id: 'j-1', place: AGORA, kind: 'injoke', text: 'a joke', audience: GROUP, weight: 9 });
    assert.deepEqual(texts(lessonsOf(world.db, groupContext('fake'))), ['live']);
  } finally {
    world.close();
  }
});

test('no stored lesson reads as an empty list', () => {
  // Bug: the reader throws or returns a placeholder row for a world nobody taught anything.
  const { world } = lessonWorld();
  try {
    assert.deepEqual(lessonsOf(world.db, groupContext('fake')), []);
  } finally {
    world.close();
  }
});

test('the fields of a root hold its in-jokes, and no key for a root with none', () => {
  // Bug: placeFieldsOf reads descriptions only, so the in-jokes stored as claims never reach the root's fields.
  const { world } = lessonWorld();
  try {
    addPlaceClaim(world.db, { id: 'j-1', place: AGORA, kind: 'injoke', text: 'the soup of doom', audience: GROUP });
    addPlaceClaim(world.db, { id: 'j-2', place: AGORA, kind: 'injoke', text: 'banana law', audience: GROUP });
    const ctx = groupContext('fake');
    const fields = placeFieldsOf(world.db, ctx, AGORA);
    assert.ok(
      fields.injokes?.includes('the soup of doom') && fields.injokes.includes('banana law'),
      String(fields.injokes)
    );
    assert.equal(Object.hasOwn(placeFieldsOf(world.db, ctx, ISLAND), 'injokes'), false);
  } finally {
    world.close();
  }
});

test('the fields of a root leave out an in-joke of an audience the context may not read, and a retired one', () => {
  // Bug: the in-jokes are read without the context's audience, so a joke from a private chat shows in a group.
  const { world, zoeDm } = lessonWorld();
  try {
    addPlaceClaim(world.db, { id: 'j-1', place: AGORA, kind: 'injoke', text: 'public joke', audience: GROUP });
    addPlaceClaim(world.db, {
      id: 'j-2',
      place: AGORA,
      kind: 'injoke',
      text: 'private joke',
      audience: { dm: zoeDm, iface: 'fake', person: ZOE },
    });
    addPlaceClaim(world.db, {
      id: 'j-3',
      place: AGORA,
      kind: 'injoke',
      text: 'gone joke',
      audience: GROUP,
      retiredAt: '2026-11-02T10:00:00.000Z',
    });
    const fields = placeFieldsOf(world.db, groupContext('fake'), AGORA);
    assert.ok(fields.injokes?.includes('public joke'), String(fields.injokes));
    assert.doesNotMatch(String(fields.injokes), /private joke|gone joke/);
  } finally {
    world.close();
  }
});

// The teacher of a lesson: `from_person` when set, else the person who wrote the first of the lesson's source lines (by
// `claim_sources.position`) that the context may read and that a person wrote and the persona did not, else none. A
// stored `extra.from` such as the broken token `<@null>` names nobody.
const LINE_BY_NIKOS = 'src:fake:n1:1:seen';
const LINE_BY_ZOE = 'src:fake:z1:1:seen';
const LINE_BY_PERSONA = 'src:fake:h1:1:said';

/** The lesson world with Nikos, and one source line each of Nikos, Zoe and the persona, all in the group. */
function teacherWorld(): { world: World; zoeDm: string } {
  const made = lessonWorld();
  const { db } = made.world;
  addPerson(db, { id: NIKOS, accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Nikos'] }] });
  addSourceLine(db, { id: LINE_BY_NIKOS, place: AGORA, author: 'fake:4242', audience: GROUP });
  addSourceLine(db, { id: LINE_BY_ZOE, place: AGORA, author: 'fake:5678', audience: GROUP });
  addSourceLine(db, { id: LINE_BY_PERSONA, place: AGORA, author: 'self', audience: GROUP });
  return made;
}

const teachers = (world: World): Array<string | null> =>
  lessonsOf(world.db, groupContext('fake')).map((one) => one.teacher);

test('a lesson with no from_person is taught by the person who wrote its source line', () => {
  // Bug: the reader trusts `from_person` alone, which production leaves null for every lesson, so each reads as taught by nobody.
  const { world } = teacherWorld();
  try {
    addPlaceClaim(world.db, {
      id: 'l1',
      place: AGORA,
      kind: 'lesson',
      text: 'told',
      audience: GROUP,
      sources: [LINE_BY_NIKOS],
    });
    assert.deepEqual(teachers(world), [NIKOS]);
  } finally {
    world.close();
  }
});

test('from_person wins over the author of a source line', () => {
  // Bug: the source line overrides the teacher the row names.
  const { world } = teacherWorld();
  try {
    addPlaceClaim(world.db, {
      id: 'l1',
      place: AGORA,
      kind: 'lesson',
      text: 'told',
      audience: GROUP,
      teacher: ZOE,
      sources: [LINE_BY_NIKOS],
    });
    assert.deepEqual(teachers(world), [ZOE]);
  } finally {
    world.close();
  }
});

test("the persona's own source line is skipped and the next line by a person names the teacher", () => {
  // Bug: the first source line names the teacher whoever wrote it, and the persona becomes the teacher of what they
  // were told.
  const { world } = teacherWorld();
  try {
    addPlaceClaim(world.db, {
      id: 'l1',
      place: AGORA,
      kind: 'lesson',
      text: 'told',
      audience: GROUP,
      sources: [LINE_BY_PERSONA, LINE_BY_NIKOS],
    });
    assert.deepEqual(teachers(world), [NIKOS]);
  } finally {
    world.close();
  }
});

test('the first source line by a person in the claim order names the teacher', () => {
  // Bug: the source lines are read in the order of their ids or their times, not of `claim_sources.position`.
  const { world } = teacherWorld();
  try {
    addPlaceClaim(world.db, {
      id: 'l1',
      place: AGORA,
      kind: 'lesson',
      text: 'told',
      audience: GROUP,
      sources: [LINE_BY_ZOE, LINE_BY_NIKOS],
    });
    assert.deepEqual(teachers(world), [ZOE]);
  } finally {
    world.close();
  }
});

test("a lesson whose only source line is the persona's has no teacher", () => {
  // Bug: the persona is named as the teacher of a lesson, and their own handle stands in `<lessons>`.
  const { world } = teacherWorld();
  try {
    addPlaceClaim(world.db, {
      id: 'l1',
      place: AGORA,
      kind: 'lesson',
      text: 'told',
      audience: GROUP,
      sources: [LINE_BY_PERSONA],
    });
    assert.deepEqual(teachers(world), [null]);
  } finally {
    world.close();
  }
});

test('a broken or unknown extra.from names nobody', () => {
  // Bug: the `<@null>` the place-notes writer stored, or a mention no account holds, is taken for a teacher.
  const { world } = teacherWorld();
  try {
    addPlaceClaim(world.db, {
      id: 'l1',
      place: AGORA,
      kind: 'lesson',
      text: 'one',
      audience: GROUP,
      weight: 3,
      extra: '{"from":"<@null>"}',
    });
    addPlaceClaim(world.db, {
      id: 'l2',
      place: AGORA,
      kind: 'lesson',
      text: 'two',
      audience: GROUP,
      weight: 2,
      extra: '{"from":"<@99999>"}',
    });
    assert.deepEqual(teachers(world), [null, null]);
  } finally {
    world.close();
  }
});

test('a source line the context may not read gives no teacher, and the next readable line does', () => {
  // Bug: the author of a private line is named in a group read, which tells the group who was in a private chat.
  const { world, zoeDm } = teacherWorld();
  try {
    const private_ = 'src:fake:p1:1:seen';
    addSourceLine(world.db, {
      id: private_,
      place: zoeDm,
      author: ZOE,
      audience: { dm: zoeDm, iface: 'fake', person: ZOE },
    });
    addPlaceClaim(world.db, {
      id: 'l1',
      place: AGORA,
      kind: 'lesson',
      text: 'one',
      audience: GROUP,
      weight: 3,
      sources: [private_],
    });
    addPlaceClaim(world.db, {
      id: 'l2',
      place: AGORA,
      kind: 'lesson',
      text: 'two',
      audience: GROUP,
      weight: 2,
      sources: [private_, LINE_BY_NIKOS],
    });
    assert.deepEqual(teachers(world), [null, NIKOS]);
  } finally {
    world.close();
  }
});

// The persona's memory session writes lessons about the persona: the subject `self` (`subject_id` the persona's id),
// the weight left null, `how` one of `taught`, `saw`, `said` and `inferred`, under a group or a direct chat's audience.
// They are what the persona learned about themselves from everyone, and `lessonsOf` reads them beside the lessons of a
// place.
const SELF_LESSON = { subject: 'self', how: 'saw' } as const;

test('a lesson about the persona comes back beside the lessons of a place', () => {
  // Bug: the reader takes claims whose subject is a place, so the lessons the persona's memory session wrote about the
  // persona never show.
  const { world } = lessonWorld();
  try {
    addPlaceClaim(world.db, {
      id: 'l-place',
      place: AGORA,
      kind: 'lesson',
      text: 'about the place',
      audience: GROUP,
      weight: 3,
    });
    addPlaceClaim(world.db, {
      id: 'l-self',
      place: AGORA,
      kind: 'lesson',
      text: 'about her',
      audience: GROUP,
      weight: 1,
      ...SELF_LESSON,
    });
    assert.deepEqual(texts(lessonsOf(world.db, groupContext('fake'))), ['about the place', 'about her']);
  } finally {
    world.close();
  }
});

test('a lesson with no weight ranks as the weight 1', () => {
  // Bug: a null weight ranks as 0 (log2(0.5) is -1), and every lesson the persona's session wrote sinks below the
  // weakest of a place.
  // W3: weight 3 seen 2026-11-01 (rank 1.81). SELF: no weight seen 2026-11-05 (0.59, as weight 1). W1: weight 1 seen
  // 2026-11-01 (0.58). The order is W3, SELF, W1.
  const { world } = lessonWorld();
  try {
    const seen = (day: string) => `2026-11-${day}T10:00:00.000Z`;
    addPlaceClaim(world.db, {
      id: 'l-w1',
      place: AGORA,
      kind: 'lesson',
      text: 'W1',
      audience: GROUP,
      weight: 1,
      seenAt: seen('01'),
    });
    addPlaceClaim(world.db, {
      id: 'l-w3',
      place: AGORA,
      kind: 'lesson',
      text: 'W3',
      audience: GROUP,
      weight: 3,
      seenAt: seen('01'),
    });
    addPlaceClaim(world.db, {
      id: 'l-self',
      place: AGORA,
      kind: 'lesson',
      text: 'SELF',
      audience: GROUP,
      weight: null,
      seenAt: seen('05'),
      ...SELF_LESSON,
    });
    assert.deepEqual(texts(lessonsOf(world.db, groupContext('fake'))), ['W3', 'SELF', 'W1']);
  } finally {
    world.close();
  }
});

test('a lesson about the persona under a direct chat audience shows in that chat and not in a group', () => {
  // Bug: the audience of a `self` claim is ignored (shows in every group) or never matched (never shows in its chat).
  const { world, zoeDm } = lessonWorld();
  try {
    const audience = { dm: zoeDm, iface: 'fake', person: ZOE };
    addPlaceClaim(world.db, {
      id: 'l-self',
      place: zoeDm,
      kind: 'lesson',
      text: 'told in private',
      audience,
      weight: null,
      ...SELF_LESSON,
    });
    assert.deepEqual(texts(lessonsOf(world.db, dmContext(ZOE, 'fake', zoeDm))), ['told in private']);
  } finally {
    world.close();
  }
});

test('a lesson about the persona under a direct chat audience stays out of a group read', () => {
  // Bug: a lesson learned in a private chat shows in a room.
  const { world, zoeDm } = lessonWorld();
  try {
    const audience = { dm: zoeDm, iface: 'fake', person: ZOE };
    addPlaceClaim(world.db, {
      id: 'l-self',
      place: zoeDm,
      kind: 'lesson',
      text: 'told in private',
      audience,
      weight: null,
      ...SELF_LESSON,
    });
    assert.deepEqual(lessonsOf(world.db, groupContext('fake')), []);
  } finally {
    world.close();
  }
});

test('a lesson about the persona is taught by the person who wrote its source line', () => {
  // Bug: the teacher of a `self` lesson is read from `from_person` alone, which the persona's session leaves null.
  const { world } = teacherWorld();
  try {
    addPlaceClaim(world.db, {
      id: 'l-self',
      place: AGORA,
      kind: 'lesson',
      text: 'about her',
      audience: GROUP,
      weight: null,
      sources: [LINE_BY_NIKOS],
      ...SELF_LESSON,
    });
    assert.deepEqual(teachers(world), [NIKOS]);
  } finally {
    world.close();
  }
});

// ---- The people the persona feels most strongly about ------------------------------------------------------------
// `strongestAttitudesOf` reads `affinity_events` under the context: a person's score is the score of their newest change
// the context may read, retired changes left out. A person whose score lies in the band `neutral` (above -8 and below 8)
// is not listed. The rest come by distance from zero, the largest first, ties by person id, at most `limit`.

const day = (n: number): string => `2026-11-${String(n).padStart(2, '0')}T10:00:00.000Z`;

/** A person with one account on `fake`, named for the id. */
function known(world: World, id: string): string {
  const native = id.replace(/\D/g, '') || id;
  addPerson(world.db, { id, accounts: [{ id: `fake:${native}`, iface: 'fake', native, names: [`Name ${native}`] }] });
  return id;
}

/** One change of the attitude toward `person` under the groups of `fake`, the score after it given. */
function change(world: World, person: string, n: number, score: number, over: { audience?: Audience } = {}): string {
  const id = `aff:${person}:${n}`;
  addAttitude(world.db, {
    id,
    person,
    at: day(n),
    applied: score,
    score,
    reason: null,
    audience: over.audience ?? GROUP,
  });
  return id;
}

const scoresOf = (world: World, limit = 10): Array<[string, number]> =>
  strongestAttitudesOf(world.db, groupContext('fake'), limit).map((one) => [one.person, one.score]);

test('the strongest attitudes come by distance from zero, warm and cool mixed', () => {
  // Bug: the list is sorted by the signed score, so the people the persona dislikes most stand last instead of first.
  const { world } = lessonWorld();
  try {
    const [a, b, c, d] = ['person:fake:1', 'person:fake:2', 'person:fake:3', 'person:fake:4'].map((id) =>
      known(world, id)
    );
    change(world, a ?? '', 1, 30);
    change(world, b ?? '', 1, -70);
    change(world, c ?? '', 1, 62);
    change(world, d ?? '', 1, -26);
    assert.deepEqual(scoresOf(world), [
      ['person:fake:2', -70],
      ['person:fake:3', 62],
      ['person:fake:1', 30],
      ['person:fake:4', -26],
    ]);
  } finally {
    world.close();
  }
});

test('the list is cut to the limit, and a limit of zero gives none', () => {
  // Bug: the limit is ignored, or applied before the sort so the cut keeps the first people stored, or 0 reads as no limit.
  const { world } = lessonWorld();
  try {
    ['person:fake:1', 'person:fake:2', 'person:fake:3'].forEach((id, at) =>
      change(world, known(world, id), 1, 30 + at * 10)
    );
    assert.deepEqual(scoresOf(world, 2), [
      ['person:fake:3', 50],
      ['person:fake:2', 40],
    ]);
    assert.deepEqual(scoresOf(world, 0), []);
  } finally {
    world.close();
  }
});

test('a score in the band neutral is not listed, and the edges of the band are', () => {
  // Bug: the neutral people fill the list, or the cut sits at the wrong side of the edge: 8 is warm and -8 is cool, while
  // 7.9 and -7.9 are neutral.
  const { world } = lessonWorld();
  try {
    change(world, known(world, 'person:fake:1'), 1, 7.9);
    change(world, known(world, 'person:fake:2'), 1, -7.9);
    change(world, known(world, 'person:fake:3'), 1, 8);
    change(world, known(world, 'person:fake:4'), 1, -8);
    change(world, known(world, 'person:fake:5'), 1, 0);
    assert.deepEqual(scoresOf(world), [
      ['person:fake:3', 8],
      ['person:fake:4', -8],
    ]);
  } finally {
    world.close();
  }
});

test('a person who moved back into the neutral band is not listed for the older, stronger change', () => {
  // Bug: the reader takes the strongest change of a person instead of the newest, so a settled feeling still lists them.
  const { world } = lessonWorld();
  try {
    const person = known(world, 'person:fake:1');
    change(world, person, 1, 55);
    change(world, person, 3, 4);
    assert.deepEqual(scoresOf(world), []);
  } finally {
    world.close();
  }
});

test('the score is the one of the newest change, whatever the order of storage', () => {
  // Bug: the first or the last stored row stands for the person, or the oldest change wins.
  const { world } = lessonWorld();
  try {
    const person = known(world, 'person:fake:1');
    change(world, person, 5, -40);
    change(world, person, 2, 45);
    change(world, person, 9, 12);
    const [only] = strongestAttitudesOf(world.db, groupContext('fake'), 5);
    assert.deepEqual([only?.person, only?.score, only?.at.slice(0, 10)], [person, 12, '2026-11-09']);
  } finally {
    world.close();
  }
});

test('a change under a direct chat the context may not read neither lists a person nor moves a score in a group', () => {
  // Bug: the read has no audience, so what the persona felt in a private chat shows in a group: the first has only a
  // private change, the second has a group change and a newer private one.
  const { world, zoeDm } = lessonWorld();
  try {
    const private_ = { dm: zoeDm, iface: 'fake', person: ZOE } as const;
    change(world, known(world, 'person:fake:1'), 4, -80, { audience: private_ });
    const two = known(world, 'person:fake:2');
    change(world, two, 1, 30);
    change(world, two, 5, -50, { audience: private_ });
    assert.deepEqual(scoresOf(world), [['person:fake:2', 30]]);
  } finally {
    world.close();
  }
});

test('a direct chat reads the changes made in it and in the groups, newest first', () => {
  // Bug: the read keeps to groups, so a feeling that moved in a chat never shows in that chat.
  const { world, zoeDm } = lessonWorld();
  try {
    const private_ = { dm: zoeDm, iface: 'fake', person: ZOE } as const;
    change(world, known(world, 'person:fake:1'), 4, -80, { audience: private_ });
    const two = known(world, 'person:fake:2');
    change(world, two, 1, 30);
    change(world, two, 5, -50, { audience: private_ });
    const read = strongestAttitudesOf(world.db, dmContext(ZOE, 'fake', zoeDm), 5).map((one) => [one.person, one.score]);
    assert.deepEqual(read, [
      ['person:fake:1', -80],
      ['person:fake:2', -50],
    ]);
  } finally {
    world.close();
  }
});

test('a retired change does not count, and a person with only retired changes is not listed', () => {
  // Bug: the retired rows are read, so a withdrawn change still sets the score or lists a person.
  const { world } = lessonWorld();
  try {
    const one = known(world, 'person:fake:1');
    change(world, one, 1, 40);
    const gone = change(world, one, 3, -70);
    const two = known(world, 'person:fake:2');
    const only = change(world, two, 2, 60);
    for (const id of [gone, only]) {
      world.db.prepare('UPDATE affinity_events SET retired_at = ? WHERE id = ?').run('2026-11-10T10:00:00.000Z', id);
    }
    assert.deepEqual(scoresOf(world), [['person:fake:1', 40]]);
  } finally {
    world.close();
  }
});

test('people at the same distance from zero come in the order of their ids', () => {
  // Bug: a tie keeps the order of storage or of the signed score, so the order of the block moves between reads.
  const { world } = lessonWorld();
  try {
    change(world, known(world, 'person:fake:30'), 1, 40);
    change(world, known(world, 'person:fake:10'), 1, -40);
    change(world, known(world, 'person:fake:20'), 1, 40);
    assert.deepEqual(
      scoresOf(world).map(([person]) => person),
      ['person:fake:10', 'person:fake:20', 'person:fake:30']
    );
  } finally {
    world.close();
  }
});

test('a world with no stored change reads as an empty list', () => {
  // Bug: the reader throws or answers a placeholder row for a person with no change.
  const { world } = lessonWorld();
  try {
    known(world, 'person:fake:1');
    assert.deepEqual(strongestAttitudesOf(world.db, groupContext('fake'), 6), []);
  } finally {
    world.close();
  }
});

test("a place's description of the turn's own audience comes first, a direct chat's only in that chat", () => {
  // Bug: the fields put a direct chat's description first, so an open group turn shows what Zoe's chat wrote of the root.
  const { world, zoeDm } = lessonWorld();
  try {
    const describe = (id: string, text: string, scope: Record<string, string>) =>
      insertRows(world.db, {
        descriptions: [
          { id, subject_kind: 'place', subject_id: AGORA, field: 'purpose', current_version: `${id}:v1`, ...scope },
        ],
        description_versions: [
          { id: `${id}:v1`, description_id: id, text, author: 'her', written_at: '2026-11-01T10:00:00.000Z', chars: 1 },
        ],
      });
    describe('d:0', 'from the direct chat', { scope_kind: 'dm', scope_iface: 'fake', scope_dm: ZOE });
    describe('d:1', 'from the group', { scope_kind: 'group', scope_iface: 'fake' });
    const purpose = (ctx: Parameters<typeof placeFieldsOf>[1]) => placeFieldsOf(world.db, ctx, AGORA).purpose;
    assert.equal(purpose({ ...groupContext('fake'), open: true }), 'from the group');
    assert.equal(purpose(groupContext('fake')), 'from the group');
    assert.equal(purpose(dmContext(ZOE, 'fake', zoeDm)), 'from the direct chat');
    assert.equal(purpose({ ...dmContext(ZOE, 'fake', zoeDm), open: true }), 'from the direct chat');
  } finally {
    world.close();
  }
});

const AT = '2026-11-01T10:00:00.000Z';

/** A room of the `fake` interface and one line in it stored under `id`, with message id `native` at `revision`. */
function roomWithLine(world: World, { id, native, revision = 1 }: { id: string; native: string; revision?: number }) {
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  const room = addRoom(world.db, { iface: 'fake', native: 'c7', root: rootId('fake', 'g1'), name: 'garden' });
  insertRows(world.db, {
    sources: [
      {
        id,
        kind: 'seen',
        iface: 'fake',
        native_id: native,
        native_kind: 'message',
        revision,
        place_id: room,
        author_account: null,
        occurred_at: AT,
        recorded_at: AT,
        text: 'το κουνέλι',
        scope_kind: 'group',
        scope_iface: 'fake',
        scope_dm: null,
      },
    ],
  });
  return room;
}

/** The persona's line `native` in the place `place`, written by the account `account`, scoped as `scope`. */
function ownLine(
  world: World,
  {
    place,
    native,
    account,
    scope,
    at = AT,
  }: { place: string; native: string; account: string | null; scope: 'group' | 'dm'; at?: string }
) {
  insertRows(world.db, {
    sources: [
      {
        id: `source:${native}`,
        kind: 'said',
        iface: 'fake',
        native_id: native,
        native_kind: 'message',
        revision: 1,
        place_id: place,
        author_account: account,
        author_kind: 'self',
        occurred_at: at,
        recorded_at: at,
        text: 'η αυλή',
        scope_kind: scope,
        scope_iface: 'fake',
        scope_dm: scope === 'dm' ? 'person:7e21' : null,
      },
    ],
  });
}

/** A room of the `fake` interface that holds the persona's lines under test. */
function gardenOf(world: World): string {
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  return addRoom(world.db, { iface: 'fake', native: 'c9', root: rootId('fake', 'g1'), name: 'garden' });
}

/** One image item with `description` (null: no text form yet) linked to the stored line `source`. */
function pictureOn(world: World, source: string, description: string | null) {
  world.db
    .prepare(
      `INSERT INTO media (id, kind, availability, description, scope_kind, scope_iface)
       VALUES (?, 'image', ?, ?, 'group', 'fake')`
    )
    .run(`media:${source}`, description === null ? 'unknown' : 'present', description);
  world.db
    .prepare("INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', ?, 0, ?)")
    .run(source, `media:${source}`);
}

/** The scene of production's edit (fixtures/memory-db/edited-line.ts) in a room of the `fake` interface. */
function editedRoom(world: World): string {
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  const room = addRoom(world.db, { iface: 'fake', native: 'c7', root: rootId('fake', 'g1'), name: 'garden' });
  storeProductionEdit(world.db, { iface: 'fake', place: room });
  return room;
}

const shown = (lines: ReadonlyArray<{ id: string; self: boolean; text: string }>) =>
  lines.map((line) => [line.id, line.self, line.text]);

const IN_ORDER = [
  ['owner-1', false, 'first words'],
  ['hers-1', true, 'the kettle is on'],
  ['owner-2', false, 'second words'],
  ['hers-2', true, 'her next words'],
];

/** `db` with every statement it runs kept as its SQL and parameters, in the order they ran. */
function recording(db: Db): { db: Db; ran: Array<{ sql: string; params: Array<unknown> }> } {
  const ran: Array<{ sql: string; params: Array<unknown> }> = [];
  const prepare = (sql: string): Statement => {
    const statement = db.prepare(sql);
    const note = (params: Array<unknown>): void => {
      ran.push({ sql, params });
    };
    return {
      get: (...params) => (note(params), statement.get(...params)),
      all: (...params) => (note(params), statement.all(...params)),
      run: (...params) => (note(params), statement.run(...params)),
      iterate: (...params) => (note(params), statement.iterate(...params)),
    };
  };
  return { db: { prepare, exec: (sql) => db.exec(sql) }, ran };
}

/** The plan lines SQLite gives for each statement that ran. */
const plansOf = (db: Db, ran: ReadonlyArray<{ sql: string; params: Array<unknown> }>): Array<Array<string>> =>
  ran.map(({ sql, params }) =>
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => String(row.detail))
  );

/** A search of a place's rows that `sources_place_time` bounds by a range of `occurred_at`. */
const PLACE_TIME_RANGE = /^SEARCH s USING (COVERING )?INDEX sources_place_time \(place_id=\? AND occurred_at[<>]/;
/** A walk of every row of a place, or of every row of `sources`. */
const WHOLE_PLACE = /^SEARCH s USING (COVERING )?INDEX sources_place_time \(place_id=\?\)$|^SCAN (s|t|sources)\b/;

/**
 * A room of edits, retired lines and lines of one moment: `kappa` edited twice, the later rows at the line's moment
 * and recorded at the moments of the edits, as the writer and schema step 67 store them; `lambda` retired; `mu`, `nu` and `xi` written at one moment; `omicron` edited at its own moment; `pi` written
 * at the moment of `kappa`'s first edit; `rho` retired in its edit, so its first revision stands.
 */
function revisedRoom(world: World): string {
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  const room = addRoom(world.db, { iface: 'fake', native: 'c9', root: rootId('fake', 'g1'), name: 'orchard' });
  const where = { iface: 'fake', place: room };
  storeRevision(world.db, where, { native: 'iota', text: 'iota words', at: minute(0), kind: 'seen', by: 'someone' });
  storeRevision(world.db, where, { native: 'kappa', text: 'kappa one', at: minute(1), kind: 'said', by: 'her' });
  storeRevision(world.db, where, { native: 'lambda', text: 'lambda gone', at: minute(2), kind: 'seen', by: 'someone' });
  for (const native of ['mu', 'nu', 'xi'])
    storeRevision(world.db, where, { native, text: `${native} words`, at: minute(3), kind: 'seen', by: 'someone' });
  storeRevision(world.db, where, { native: 'omicron', text: 'omicron one', at: minute(4), kind: 'said', by: 'her' });
  storeRevision(world.db, where, { native: 'rho', text: 'rho one', at: minute(5), kind: 'seen', by: 'someone' });
  const later = { kind: 'seen', by: 'her' } as const;
  storeRevision(world.db, where, {
    native: 'kappa',
    text: 'kappa two',
    at: minute(1),
    recordedAt: minute(1) + EDIT_DELAY_MS,
    revision: 2,
    ...later,
  });
  storeRevision(world.db, where, {
    native: 'pi',
    text: 'pi words',
    at: minute(1) + EDIT_DELAY_MS,
    kind: 'seen',
    by: 'someone',
  });
  storeRevision(world.db, where, {
    native: 'kappa',
    text: 'kappa three',
    at: minute(1),
    recordedAt: minute(150),
    revision: 3,
    ...later,
  });
  storeRevision(world.db, where, { native: 'omicron', text: 'omicron two', at: minute(4), revision: 2, ...later });
  storeRevision(world.db, where, {
    native: 'rho',
    text: 'rho two',
    at: minute(5),
    recordedAt: minute(160),
    revision: 2,
    kind: 'seen',
    by: 'someone',
  });
  world.db.exec(
    `UPDATE sources SET retired_at = '2026-11-12T05:00:00.000Z' WHERE id IN ('source:lambda:1', 'source:rho:2')`
  );
  return room;
}

/** Each line as its id, text and minute from the scene's start, lines of one moment in the order of their ids. */
const answered = (lines: ReadonlyArray<{ id: string; text: string; at: number }>) =>
  [...lines]
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .map((line) => [line.id, line.text, (line.at - minute(0)) / 60_000]);

test('the line of a source stored under an opaque id is live while its message stands', () => {
  // Bug: the reader cut the message id out of the source id's text, so a line stored under an opaque id read as gone.
  const world = openWorld();
  try {
    roomWithLine(world, { id: 'source:opaque-1', native: 'm-42', revision: 2 });
    assert.equal(sourceRetiredOf(world.db, internalContext(), 'source:opaque-1'), false);
  } finally {
    world.close();
  }
});

test('the line of a source is retired when its message was deleted', () => {
  // Bug: a deleted message read by its source keeps its lookup in <recall> as if the line were there.
  const world = openWorld();
  try {
    const room = roomWithLine(world, { id: 'source:opaque-2', native: 'm-43' });
    insertRows(world.db, {
      sources: [
        {
          id: 'source:opaque-2-deleted',
          kind: 'deleted',
          iface: 'fake',
          native_id: 'm-43',
          native_kind: 'message',
          revision: 2,
          place_id: room,
          occurred_at: AT,
          recorded_at: AT,
          text: '',
          scope_kind: 'group',
          scope_iface: 'fake',
          scope_dm: null,
        },
      ],
    });
    assert.equal(sourceRetiredOf(world.db, internalContext(), 'source:opaque-2'), true);
  } finally {
    world.close();
  }
});

test('a source id no row holds is retired', () => {
  // Bug: a source id of the `src:` shape is respelled into a message id and finds a line of another source.
  const world = openWorld();
  try {
    roomWithLine(world, { id: 'source:opaque-3', native: 'm-44' });
    assert.equal(sourceRetiredOf(world.db, internalContext(), 'src:fake:m-44:1:seen'), true);
  } finally {
    world.close();
  }
});

test('a line around a moment carries the id of its source row', () => {
  // Bug: a reader of the line respelled a source id from its interface and message id, a row that may not exist.
  const world = openWorld();
  try {
    const room = roomWithLine(world, { id: 'source:opaque-4', native: 'm-45', revision: 3 });
    const lines = linesAroundOf(world.db, internalContext(), room, Date.parse(AT), 2);
    assert.deepEqual(
      lines.map((line) => [line.id, line.sourceId]),
      [['m-45', 'source:opaque-4']]
    );
  } finally {
    world.close();
  }
});

test("the persona's line in a room stored under an opaque id has a path that starts with the interface of its row", () => {
  // Bug: the path took the interface from the text of the place id, so a room stored as `place:...` sat under `place`.
  const world = openWorld();
  try {
    noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
    world.db
      .prepare(
        `INSERT INTO places (id, iface, kind, native_id, parent_id, chat, scope_kind, name)
         VALUES ('place:opaque-room', 'fake', 'channel', 'c8', ?, 'group', 'group', 'garden')`
      )
      .run(rootId('fake', 'g1'));
    ownLine(world, { place: 'place:opaque-room', native: 'm-50', account: null, scope: 'group' });
    const [line] = ownLinesOf(world.db, internalContext(), null, 5);
    // A place reads in words: a line carries its place's interface and chain
    // (innermost first, with kinds) instead of a path of names, so a request can give each link its interface's noun.
    assert.equal(line?.iface, 'fake');
    assert.deepEqual(
      line?.chain.map((link) => [link.kind, link.name]),
      [
        ['channel', 'garden'],
        ['server', 'Agora'],
      ]
    );
  } finally {
    world.close();
  }
});

test("the persona's line in a direct chat stored under an opaque id is one unnamed direct chat link with the partner's person", () => {
  // Bug: the partner was cut out of the text of the place id, which an opaque DM place does not spell.
  const world = openWorld();
  try {
    world.db.exec(`INSERT INTO people (id) VALUES ('person:7e21');
      INSERT INTO accounts (id, iface, native_id, person_id) VALUES ('account:opaque-partner', 'fake', 'u-77', 'person:7e21');
      INSERT INTO places (id, iface, kind, native_id, chat, scope_kind, partner_account, partner_person)
        VALUES ('place:opaque-dm', 'fake', 'dm', NULL, 'dm', 'dm', 'account:opaque-partner', 'person:7e21');`);
    ownLine(world, { place: 'place:opaque-dm', native: 'm-51', account: null, scope: 'dm' });
    const [line] = ownLinesOf(world.db, internalContext(), null, 5);
    // The chain is the one unnamed `dm` link, no `private` and no platform id.
    assert.deepEqual(
      [line?.iface, line?.chain.map((link) => [link.id, link.kind, link.name]), line?.dm, line?.partner],
      ['fake', [['place:opaque-dm', 'dm', null]], true, 'person:7e21']
    );
  } finally {
    world.close();
  }
});

test("a line's author id is the native id of its author account's row", () => {
  // Bug: the author id was cut out of the text of the account id, which an opaque account does not spell.
  const world = openWorld();
  try {
    const room = roomWithLine(world, { id: 'source:opaque-5', native: 'm-46' });
    world.db.exec(`INSERT INTO accounts (id, iface, native_id) VALUES ('account:opaque-self', 'fake', 'self-9')`);
    ownLine(world, { place: room, native: 'm-52', account: 'account:opaque-self', scope: 'group' });
    const [line] = ownLinesOf(world.db, internalContext(), null, 5);
    assert.equal(line?.authorId, 'self-9');
  } finally {
    world.close();
  }
});

test("the persona's picture-only line is among their own lines with the description of its media", () => {
  // Bug: a post that is only a picture has empty text, so the live-line filter dropped it and <meanwhile> never
  // listed it, though its description was stored.
  const world = openWorld();
  try {
    const room = gardenOf(world);
    addLine(world.db, {
      id: 'm-text',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'η αυλή',
      at: '2026-11-01T09:00:00.000Z',
    });
    addLine(world.db, {
      id: 'm-pic',
      iface: 'fake',
      place: room,
      author: 'self',
      text: '',
      at: '2026-11-01T10:00:00.000Z',
    });
    pictureOn(world, 'm-pic', 'a white rabbit in a garden');
    const lines = ownLinesOf(world.db, internalContext(), null, 5);
    const picture = lines.find((line) => line.id === 'm-pic');
    assert.ok(picture, 'the picture-only line is listed');
    assert.deepEqual(
      picture.media.map((item) => [item.kind, item.text]),
      [['image', 'a white rabbit in a garden']]
    );
  } finally {
    world.close();
  }
});

test("a line with empty text and no media stays out of the persona's own lines", () => {
  // Bug: relaxing the filter for pictures must not let an empty line through as a blank entry.
  const world = openWorld();
  try {
    const room = gardenOf(world);
    addLine(world.db, {
      id: 'm-text',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'η αυλή',
      at: '2026-11-01T09:00:00.000Z',
    });
    addLine(world.db, {
      id: 'm-empty',
      iface: 'fake',
      place: room,
      author: 'self',
      text: '',
      at: '2026-11-01T10:00:00.000Z',
    });
    const ids = ownLinesOf(world.db, internalContext(), null, 5).map((line) => line.id);
    assert.deepEqual(ids, ['m-text']);
  } finally {
    world.close();
  }
});

test('a picture-only line is among the lines around a line', () => {
  // Bug: the lines around a line of the persona's skipped a neighbour that was only a picture, so the window had a hole.
  const world = openWorld();
  try {
    const room = gardenOf(world);
    addLine(world.db, {
      id: 'm-1',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'πρώτη',
      at: '2026-11-01T09:00:00.000Z',
    });
    addLine(world.db, {
      id: 'm-pic',
      iface: 'fake',
      place: room,
      author: 'self',
      text: '',
      at: '2026-11-01T09:01:00.000Z',
    });
    addLine(world.db, {
      id: 'm-3',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'τρίτη',
      at: '2026-11-01T09:02:00.000Z',
    });
    pictureOn(world, 'm-pic', 'a white rabbit in a garden');
    const lines = linesAroundOf(world.db, internalContext(), room, Date.parse('2026-11-01T09:01:00.000Z'), 1);
    assert.deepEqual(
      lines.map((line) => line.id),
      ['m-1', 'm-pic', 'm-3']
    );
  } finally {
    world.close();
  }
});

test("every chat is a place a #handle may name: a direct chat and the command line's chat as well as a channel", () => {
  // Bug: only channels and threads were listed, so a handle of a direct chat or of the command line's chat named nothing
  // and the tools that take a place refused the places the persona talks in most.
  const world = openWorld();
  try {
    noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
    addRoom(world.db, { iface: 'fake', native: 'c7', root: rootId('fake', 'g1'), name: 'garden' });
    addPerson(world.db, {
      id: 'person:zoe',
      accounts: [{ id: 'fake:u1', iface: 'fake', native: 'u1', names: ['Zoé'] }],
    });
    addPerson(world.db, {
      id: 'person:owner',
      accounts: [{ id: 'cli:owner', iface: 'cli', native: 'owner', names: ['Orestis'] }],
    });
    const dm = addDm(world.db, { iface: 'fake', native: 'u1', person: 'person:zoe', account: 'fake:u1' });
    const cli = addDm(world.db, { iface: 'cli', native: 'owner', person: 'person:owner', account: 'cli:owner' });
    const listed = new Map(chatPlacesOf(world.db).map((one) => [one.id, one.nativeId]));
    assert.equal(listed.get(dm), 'u1');
    assert.equal(listed.get(cli), 'owner');
    assert.equal(listed.get(rootId('fake', 'g1')), undefined, 'a root is no chat');
  } finally {
    world.close();
  }
});

// Bug: an edit stored with the moment of the edit made a read from a moment hand back the first
// revision's text at its old place, or the edit at the end of the window, so `<meanwhile>` and conversation.read showed
// the persona's line twice or in the wrong place.
test("a read from a moment gives the persona's edited line once, at the place it was said, with the new text", () => {
  const world = openWorld();
  try {
    const room = editedRoom(world);
    const lines = linesSinceOf(world.db, internalContext(), room, minute(0), 10);
    assert.deepEqual(shown(lines), IN_ORDER);
  } finally {
    world.close();
  }
});

test("a read around a line gives the persona's edited line once, at the place it was said, with the new text", () => {
  const world = openWorld();
  try {
    const room = editedRoom(world);
    const lines = linesAroundOf(world.db, internalContext(), room, minute(2), 5);
    assert.deepEqual(shown(lines), IN_ORDER);
  } finally {
    world.close();
  }
});

// Bug: the persona's newest lines elsewhere are ordered by the edit's moment, so an old line they fixed reads as the newest.
test("the persona's newest lines in other places date an edited line by the moment it was said", () => {
  const world = openWorld();
  try {
    editedRoom(world);
    const found = ownLinesOf(world.db, internalContext(), null, 10);
    assert.deepEqual(
      found.map((line) => [line.id, line.at]),
      [
        ['hers-2', minute(3)],
        ['hers-1', minute(1)],
      ]
    );
    assert.equal(found[1]?.text, 'the kettle is on');
  } finally {
    world.close();
  }
});

// Bug: a reference to the line quotes it under the moment of its edit.
test('a line by its identity is dated by the moment it was said once it is edited', () => {
  const world = openWorld();
  try {
    editedRoom(world);
    const line = lineOfIdentity(world.db, internalContext(), 'src:fake:hers-1');
    assert.deepEqual([line?.at, line?.text, line?.self, line?.revision], [minute(1), 'the kettle is on', true, 2]);
  } finally {
    world.close();
  }
});

test('the lines around a moment are read on a range of the place-and-time index, never a walk of the whole place', () => {
  // Bug: the window filtered and sorted on the first revision's moment, an
  // expression the index cannot serve, so each read walked every row of the place: 7.4 s of a diary turn's build.
  const world = openWorld();
  try {
    const room = editedRoom(world);
    const { db, ran } = recording(world.db);
    linesAroundOf(db, internalContext(), room, minute(1), 2);
    const plans = plansOf(world.db, ran);
    assert.equal(plans.filter((plan) => plan.some((line) => PLACE_TIME_RANGE.test(line))).length > 0, true);
    assert.deepEqual(
      plans.flat().filter((line) => WHOLE_PLACE.test(line)),
      []
    );
  } finally {
    world.close();
  }
});

test('the lines since a moment are read on a range of the place-and-time index, never a walk of the whole place', () => {
  // Bug: the same expression in the read from a moment walks the whole place.
  const world = openWorld();
  try {
    const room = editedRoom(world);
    const { db, ran } = recording(world.db);
    linesSinceOf(db, internalContext(), room, minute(1), 2);
    const plans = plansOf(world.db, ran);
    assert.equal(plans.filter((plan) => plan.some((line) => PLACE_TIME_RANGE.test(line))).length > 0, true);
    assert.deepEqual(
      plans.flat().filter((line) => WHOLE_PLACE.test(line)),
      []
    );
  } finally {
    world.close();
  }
});

test('the windows around and since a moment over edits, retired lines and lines of one moment stay as they are', () => {
  // Bug: a read of the window on the indexed column changes which lines it answers: an edit read at the moment of the
  // edit, a retired row read, a line of a shared moment lost. These are the answers of the read before that change.
  const world = openWorld();
  try {
    const room = revisedRoom(world);
    const ctx = internalContext();
    assert.deepEqual(answered(linesAroundOf(world.db, ctx, room, minute(3), 2)), [
      ['mu', 'mu words', 3],
      ['nu', 'nu words', 3],
      ['xi', 'xi words', 3],
      ['omicron', 'omicron two', 4],
    ]);
    assert.deepEqual(answered(linesAroundOf(world.db, ctx, room, minute(1) + EDIT_DELAY_MS, 2)), [
      ['omicron', 'omicron two', 4],
      ['rho', 'rho one', 5],
      ['pi', 'pi words', 94],
    ]);
    assert.deepEqual(answered(linesSinceOf(world.db, ctx, room, minute(0), 4)), [
      ['iota', 'iota words', 0],
      ['kappa', 'kappa three', 1],
      ['mu', 'mu words', 3],
      ['nu', 'nu words', 3],
    ]);
    assert.deepEqual(answered(linesSinceOf(world.db, ctx, room, minute(3), 10)), [
      ['mu', 'mu words', 3],
      ['nu', 'nu words', 3],
      ['xi', 'xi words', 3],
      ['omicron', 'omicron two', 4],
      ['rho', 'rho one', 5],
      ['pi', 'pi words', 94],
    ]);
  } finally {
    world.close();
  }
});

test("the persona's lines in a mirror of their diary stay out of their own lines and the limit fills from other places", () => {
  // Bug: the copy of a diary entry in a mirror's chat read as a line the persona wrote there, so the entry reached a request twice.
  const world = openWorld();
  try {
    noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
    const mirror = addRoom(world.db, { iface: 'fake', native: 'c-diary', root: rootId('fake', 'g1'), name: 'diary' });
    const garden = addRoom(world.db, { iface: 'fake', native: 'c-garden', root: rootId('fake', 'g1'), name: 'garden' });
    world.db
      .prepare(
        "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by) VALUES ('mirror:1', 'diary', ?, 1, ?, 'owner')"
      )
      .run(mirror, AT);
    for (const native of ['m-g1', 'm-g2']) ownLine(world, { place: garden, native, account: null, scope: 'group' });
    // The mirror's copies are the newest lines, so a read that counts them fills its limit with them.
    for (const native of ['m-d1', 'm-d2', 'm-d3'])
      ownLine(world, { place: mirror, native, account: null, scope: 'group', at: '2026-11-01T11:00:00.000Z' });
    const places = ownLinesOf(world.db, internalContext(), null, 2).map((line) => line.placeId);
    assert.deepEqual(places, [garden, garden]);
  } finally {
    world.close();
  }
});

const MODEL = 'x/embed';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GARDEN = 'fake:channel:c2';
const ROOM = 'fake:channel:c1';
const HARBOUR = 'tele:channel:k1';
const NEAR: ReadonlyArray<number> = [1, 0, 0, 0];
const FAR: ReadonlyArray<number> = [0, 1, 0, 0];
/** A vector at a cosine of about 0.67 to NEAR: past the limit of an intention and short of the limit of a line. */
const BETWEEN: ReadonlyArray<number> = [0.67, Math.sqrt(1 - 0.67 * 0.67), 0, 0];
const ZOE_DM = 'fake:dm:5678';
const iso = (at: number): string => new Date(at).toISOString();

/**
 * The stored vector of a line, as the index keeps one: int8 bytes with their scale and norm, linked to the line's row.
 * Its `item_id` is another message id than the line's own, as an older index wrote it, so only the link finds the line.
 */
function addVector(world: World, line: string, at: number, vector: ReadonlyArray<number>): void {
  const { bytes, scale, norm } = quantize(vector);
  const row = world.db.prepare('SELECT rowid FROM sources WHERE id = ?').get(line);
  world.db
    .prepare(
      `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, occurred_at, kind, place_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'record', 'fake:server:g1')`
    )
    .run(
      Number(row?.rowid),
      `other-${line}`,
      `record:${line}:1`,
      MODEL,
      vector.length,
      scale,
      norm,
      new Uint8Array(bytes.buffer),
      iso(at)
    );
}

/** A line of the persona's written by `turn` (none for a line older than the turns that keep one), with its vector when given. */
function actsOwnLine(
  world: World,
  id: string,
  place: string,
  ago: number,
  turn: string | null,
  vector?: ReadonlyArray<number>
) {
  const iface = place.split(':')[0] ?? 'fake';
  addLine(world.db, { id, iface, place, author: 'self', text: `ΓΡΑΜΜΗ-${id}`, at: iso(TURN_NOW - ago), turn });
  if (vector) addVector(world, id, TURN_NOW - ago, vector);
}

/** An intention record as the store keeps it. */
const intention = (id: string, status: string, ago: number) => ({
  id,
  purpose: `ΣΚΟΠΟΣ-${id}`,
  status,
  createdAt: TURN_NOW - ago,
  updatedAt: TURN_NOW - ago,
  provenance: { kind: 'self', turnId: null, scope: 'group' },
});

/** A finished wake run that carried `intentionId`. */
function run(world: World, id: string, intentionId: string, ago: number): void {
  startRun(world.handle, {
    id,
    kind: 'intention_due',
    startedAt: TURN_NOW - ago,
    inputs: { wakes: [], intentions: [{ id: intentionId, updatedAt: null }], facts: [], placeId: null },
  });
  finishRun(world.handle, { id, status: 'succeeded', outcome: 'spoke', finishedAt: TURN_NOW - ago + 60_000 });
}

/** The world of the tests: the persona's lines near and far, a line of Ελένη's near, three intentions for one thing and one for another. */
function pastWorld(): World {
  const world = serviceWorld();
  actsOwnLine(world, 'p1', GARDEN, 30 * DAY, 'turn:a', NEAR);
  addLine(world.db, {
    id: 'p2',
    iface: 'fake',
    place: GARDEN,
    author: 'fake:111',
    text: 'ΑΠΑΝΤΗΣΗ-ΤΗΣ-ΕΛΕΝΗΣ',
    at: iso(TURN_NOW - 30 * DAY + 2 * HOUR),
  });
  world.db.prepare("UPDATE sources SET reply_to = 'p1' WHERE id = 'p2'").run();
  addVector(world, 'p2', TURN_NOW - 30 * DAY + 2 * HOUR, NEAR);
  addLine(world.db, {
    id: 'p2b',
    iface: 'fake',
    place: GARDEN,
    author: 'fake:5678',
    text: 'ΑΣΧΕΤΗ-ΓΡΑΜΜΗ',
    at: iso(TURN_NOW - 30 * DAY + 3 * HOUR),
  });
  actsOwnLine(world, 'p5', ROOM, 60 * DAY, null, NEAR);
  actsOwnLine(world, 'p3', ROOM, 20 * DAY, 'turn:b', FAR);
  actsOwnLine(world, 'p4', HARBOUR, 10 * DAY, 'turn:c', NEAR);
  writeIntentions(world.db, { op: 'value', intentions: [intention('i3', 'pending', 2 * DAY)] }, iso(TURN_NOW));
  writeIntentions(
    world.db,
    {
      op: 'archive',
      records: [
        intention('i5', 'done', 9 * DAY),
        intention('i6', 'done', 8 * DAY),
        intention('i7', 'done', 7 * DAY),
        intention('i1', 'done', 6 * DAY),
        intention('i2', 'cancelled', 4 * DAY),
        intention('i4', 'done', 5 * DAY),
      ],
    },
    iso(TURN_NOW)
  );
  run(world, 'turn:r1', 'i1', 5 * DAY);
  actsOwnLine(world, 'r1-line', ROOM, 5 * DAY, 'turn:r1');
  run(world, 'turn:r2', 'i2', 3 * DAY);
  actsOwnLine(world, 'p6', HARBOUR, 12 * DAY, 'turn:d', BETWEEN);
  // A run that wrote in Ζωή's direct chat, answered a day and a half later, and one that wrote in the garden, the same.
  run(world, 'turn:r5', 'i5', 8 * DAY);
  addLine(world.db, {
    id: 'r5-line',
    iface: 'fake',
    place: ZOE_DM,
    author: 'self',
    text: 'ΓΡΑΜΜΗ-r5',
    at: iso(TURN_NOW - 8 * DAY),
    turn: 'turn:r5',
    audience: { dm: ZOE_DM, iface: 'fake', person: 'person:fake:5678' },
  });
  answer(world, 'r5-answer', ZOE_DM, 'r5-line', TURN_NOW - 8 * DAY + 36 * HOUR);
  run(world, 'turn:r6', 'i6', 7 * DAY);
  actsOwnLine(world, 'r6-line', GARDEN, 7 * DAY, 'turn:r6');
  answer(world, 'r6-answer', GARDEN, 'r6-line', TURN_NOW - 7 * DAY + 36 * HOUR);
  // The persona's line in the room answered first by a bot, then by Ζωή, then by Ελένη.
  actsOwnLine(world, 'p7', ROOM, 15 * DAY, 'turn:e', NEAR);
  world.db.prepare("INSERT INTO accounts (id, iface, native_id, kind) VALUES ('fake:999', 'fake', '999', 'bot')").run();
  for (const [id, author, minutes] of [
    ['p7-bot', 'fake:999', 30],
    ['p7-zoe', 'fake:5678', 60],
    ['p7-eleni', 'fake:111', 120],
  ] as const) {
    addLine(world.db, {
      id,
      iface: 'fake',
      place: ROOM,
      author,
      text: `ΑΠΑΝΤΗΣΗ-${id}`,
      at: iso(TURN_NOW - 15 * DAY + minutes * 60_000),
    });
    world.db.prepare("UPDATE sources SET reply_to = 'p7' WHERE id = ?").run(id);
  }
  return world;
}

/** A line of Ζωή's in `place` at `at` that answers the line `to`. */
function answer(world: World, id: string, place: string, to: string, at: number): void {
  const dm = place === ZOE_DM;
  addLine(world.db, {
    id,
    iface: 'fake',
    place,
    author: 'fake:5678',
    text: `ΑΠΑΝΤΗΣΗ-${id}`,
    at: iso(at),
    ...(dm ? { audience: { dm: ZOE_DM, iface: 'fake', person: 'person:fake:5678' } } : {}),
  });
  world.db.prepare('UPDATE sources SET reply_to = ? WHERE id = ?').run(to, id);
}

test("the persona's near line in a direct chat keeps its text only with context.memory.openPrivate on", () => {
  // Bug: the notice before an intention blanks what the persona said one-to-one after the owner opened their memory everywhere.
  const world = pastWorld();
  try {
    addVector(world, 'r5-line', TURN_NOW - 8 * DAY, NEAR);
    const textOf = (open: boolean) =>
      frameReadsOver(
        () => world.db,
        () => ({ context: { memory: { openPrivate: open } } })
      )
        .pastActs?.({
          vector: NEAR,
          model: MODEL,
          intentionScores: new Map(),
          nearIntention: 0.65,
          nearLine: 0.7,
          limit: 10,
          now: TURN_NOW,
        })
        .find((one) => one.kind === 'line' && one.id === 'r5-line');
    const shut = textOf(false);
    const open = textOf(true);
    assert.ok(shut?.kind === 'line' && open?.kind === 'line');
    assert.equal(shut.text, null);
    assert.equal(open.text, 'ΓΡΑΜΜΗ-r5');
  } finally {
    world.close();
  }
});

const NOW = Date.parse('2026-11-05T12:00:00Z');
const ROOT = 'root';
const POSTED = 'https://tenor.example.invalid/view/spinning-cat';

/** The message as it was created: the address of a GIF as text, no embed yet. */
function created(id: string): Message {
  return {
    id,
    at: NOW - 60_000,
    content: POSTED,
    author: { id: 'member', name: 'Member', self: false, bot: false },
    replyToId: null,
    replyPingAccountId: null,
    forwardedFrom: null,
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [],
    reactions: [],
  };
}

function eventOf(eventId: string, message: Message, previous?: Message): MessageEvent {
  return {
    kind: 'message.received',
    iface: 'synthetic',
    id: eventId,
    at: NOW,
    ...(previous ? { edit: true, previous } : {}),
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
    chat: { id: 'room', kind: 'channel', chatType: 'channel', rootId: ROOT },
    message,
  };
}

/** The edit handlers over the real observation path, and what the record was asked to append. */
function editsOver(
  memory: TestMemory,
  warmMediaCache: (placeId: string, message: object) => Promise<void> | null = () => null
) {
  const appended: Array<Array<object>> = [];
  const observed = createObserve({
    hot: memory.hot,
    selfIdOf: () => 'self',
    timers: { set: () => null, clear() {} },
    memoryDb: memory.memoryDb,
  });
  const edits = createEdits({
    hot: memory.hot,
    store: null,
    reads: rig().reads,
    isServedRoot: (id) => id === ROOT,
    selfIdOf: () => 'self',
    record: {
      append: (_placeId, lines) => {
        appended.push(lines);
        return Promise.resolve({ written: lines.length, duplicates: 0 });
      },
    },
    now: () => NOW,
    warmMediaCache,
    observeLine: observed.observeLine,
    deleteLine: observed.deleteLine,
  });
  return { observed, edits, appended };
}

/** What a frame read gives of the place of the message `id` from or around `at`: its lines as `[id, self, text, at]`. */
function readFrom(memory: TestMemory, id: string, at: number, read: typeof linesSinceOf | typeof linesAroundOf) {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  const place = db
    .prepare("SELECT place_id FROM sources WHERE json_extract(extra, '$.$messageLocator.messageId') = ?")
    .get(id)?.place_id;
  return read(db, internalContext(), String(place), at, 3).map((line) => [line.id, line.self, line.text, line.at]);
}

// Guard (green before the fix): someone else's line edited in a chat with a root keeps being theirs, at its place.
test("an edit of someone else's line in a chat with a root reads as their line at the moment it was written", async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const { observed, edits } = editsOver(memory);
    const first: Message = { ...created('9200'), content: 'πρώτη μορφή' };
    const second: Message = { ...first, content: 'δεύτερη μορφή', editedAt: NOW };
    await observed.observeLine(eventOf('create-9200', first), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-9200', second, first));
    assert.deepEqual(readFrom(memory, '9200', first.at, linesSinceOf), [['9200', false, 'δεύτερη μορφή', first.at]]);
  } finally {
    await memory.close();
  }
});

// Guard for the Discord shape, where the frame reads tell an edit by the author's kind: the persona's own line edited
// in a chat with a root, the edit carrying the line's own moment.
test("an edit of the persona's own line in a chat with a root reads as theirs with the new text", async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const { observed, edits } = editsOver(memory);
    const mine = { id: 'self', name: 'Nova', self: true, bot: false };
    const first: Message = { ...created('9201'), content: 'πρώτη μορφή', author: mine };
    const second: Message = { ...first, content: 'δεύτερη μορφή', editedAt: NOW };
    await observed.observeLine(eventOf('create-9201', first), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-9201', second, first));
    assert.deepEqual(readFrom(memory, '9201', first.at, linesSinceOf), [['9201', true, 'δεύτερη μορφή', first.at]]);
  } finally {
    await memory.close();
  }
});

// Bug (found by the specifier): a read around a line puts the older revision first when both rows share a moment, and
// keeps the first row it meets, so a platform's edit shows its old text in `<meanwhile>` and conversation.read.
test("a read around a line gives someone else's edited line its new text when the edit keeps the moment", async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const { observed, edits } = editsOver(memory);
    const first: Message = { ...created('9202'), content: 'πρώτη μορφή' };
    const second: Message = { ...first, content: 'δεύτερη μορφή', editedAt: NOW };
    await observed.observeLine(eventOf('create-9202', first), false, { placeId: ROOT });
    await edits.onMessageUpdate(eventOf('update-9202', second, first));
    assert.deepEqual(readFrom(memory, '9202', first.at, linesAroundOf), [['9202', false, 'δεύτερη μορφή', first.at]]);
  } finally {
    await memory.close();
  }
});

const MIN = 60_000;
const SAY = '<think>STEP 4. So: answer.</think><msg>εντάξει</msg>';
const LESSONS_AGORA = 'fake:server:g1';
const LESSONS_ISLAND = 'tele:server:t1';
const HANDLE = /@u[0-9a-z]+/;
/** The label of an in-joke line of `<root>`, read off the labels as `fieldLines` reads it. */
const FIELD_LABELS = shippedLabels.surroundings?.fields;
const JOKES_LABEL = FIELD_LABELS?.injokes ?? 'injokes';

/** The service world, with Νίκος, who wrote nothing anywhere, and the owner with their command line chat. */
function lessonsWorld(): World {
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
  place: LESSONS_AGORA,
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
  const world = lessonsWorld();
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
const lessonsOfWorld = (request: string): string =>
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

// ---- C. the block <attitudes> ------------------------------------------------------------------------------------
// The people the persona feels most strongly about: `<attitudes>` inside `<self>` after `<lessons>`, at most
// `context.attitudes.shown` of them, the person they answer and the people of `<people>`
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

describe('reply turn lessons', () => {
  // The turn world's interface and self id are module state of the fixture: set for these cases only.
  before(() => {
    useIface('fake');
  });
  after(() => {
    useIface('discord');
  });

  test('the in-jokes of another root do not show in <root>', async () => {
    // Bug: the in-jokes are read by kind alone, so every root's jokes land in the root of the turn.
    const [request = ''] = await inRoom([
      joke('j1', 'ΑΣΤΕΙΟ-ΑΓΟΡΑΣ'),
      joke('j2', 'ΑΣΤΕΙΟ-ΝΗΣΙΟΥ', { place: LESSONS_ISLAND, audience: { group: 'tele' } }),
    ]);
    assert.match(rootOf(request), /ΑΣΤΕΙΟ-ΑΓΟΡΑΣ/);
    assert.doesNotMatch(request, /ΑΣΤΕΙΟ-ΝΗΣΙΟΥ/);
  });

  test('a root whose in-jokes were retired has no in-joke line at the next turn', async () => {
    // Bug: the line stays with an empty value, or the retired joke stays in the request.
    const world = lessonsWorld();
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
      joke('j2', 'ΑΣΤΕΙΟ-ΙΔΙΩΤΙΚΟ', { audience: { dm: ZOE_DM, iface: 'fake', person: LESSONS_ZOE } }),
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
    // another root never follows the persona.
    const [request = ''] = await inRoom([
      lesson('l1', 'ΜΑΘΗΜΑ-ΑΓΟΡΑΣ'),
      lesson('l2', 'ΜΑΘΗΜΑ-ΝΗΣΙΟΥ', { place: LESSONS_ISLAND, audience: { group: 'tele' } }),
    ]);
    const body = lessonsOfWorld(request);
    assert.ok(body.includes('ΜΑΘΗΜΑ-ΑΓΟΡΑΣ') && body.includes('ΜΑΘΗΜΑ-ΝΗΣΙΟΥ'), body);
  });

  test('<lessons> shows on the command line, an interface with no root, the lessons of every root', async () => {
    // Bug: the block is read for the root of the turn's place, and a turn with no root reads nothing.
    const world = lessonsWorld();
    try {
      addPlaceClaim(world.db, lesson('l1', 'ΜΑΘΗΜΑ-ΑΓΟΡΑΣ'));
      addPlaceClaim(world.db, lesson('l2', 'ΜΑΘΗΜΑ-ΝΗΣΙΟΥ', { place: LESSONS_ISLAND, audience: { group: 'tele' } }));
      const owner = { id: 'm1', text: 'καλημέρα', at: TURN_NOW - MIN, authorId: 'owner', authorName: 'owner' };
      const step: ReplyStep = { trigger: owner, answers: [SAY] };
      const run = await replyRun({
        world,
        chat: CLI_CHAT,
        steps: [step],
        context: { lessons: { budgetTokens: 100_000 } },
      });
      const [turnRequests = []] = run.requests;
      const body = lessonsOfWorld(turnRequests[0] ?? '');
      assert.ok(body.includes('ΜΑΘΗΜΑ-ΑΓΟΡΑΣ') && body.includes('ΜΑΘΗΜΑ-ΝΗΣΙΟΥ'), body);
    } finally {
      world.close();
    }
  });

  test('a lesson under an audience the turn may not read does not show in a group', async () => {
    // Bug: the lessons are read without the turn's context, so what a person taught the persona in private shows in a room.
    const [request = ''] = await inRoom([
      lesson('l1', 'ΜΑΘΗΜΑ-ΔΗΜΟΣΙΟ'),
      lesson('l2', 'ΜΑΘΗΜΑ-ΙΔΙΩΤΙΚΟ', { place: ZOE_DM, audience: { dm: ZOE_DM, iface: 'fake', person: LESSONS_ZOE } }),
    ]);
    assert.match(lessonsOfWorld(request), /ΜΑΘΗΜΑ-ΔΗΜΟΣΙΟ/);
    assert.doesNotMatch(request, /ΜΑΘΗΜΑ-ΙΔΙΩΤΙΚΟ/);
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
    const body = lessonsOfWorld(request);
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

  test('<root> holds no lessons line', async () => {
    // Bug: the lessons stay in the fields of the root beside the block, so each shows twice.
    const [request = ''] = await inRoom([lesson('l1', 'ΜΑΘΗΜΑ-ΑΓΟΡΑΣ'), joke('j1', 'ΑΣΤΕΙΟ-ΑΓΟΡΑΣ')]);
    assert.match(lessonsOfWorld(request), /ΜΑΘΗΜΑ-ΑΓΟΡΑΣ/);
    assert.match(rootOf(request), /ΑΣΤΕΙΟ-ΑΓΟΡΑΣ/);
    assert.doesNotMatch(rootOf(request), /ΜΑΘΗΜΑ-ΑΓΟΡΑΣ/);
  });

  test('a lesson stored as production stores it names the writer of its source line, by the handle of that entry', async () => {
    // Bug: the teacher is read from `from_person` alone, which production leaves null, so every lesson loses its teacher.
    const line = 'src:fake:n1:1:seen';
    const [request = ''] = await inRoom(
      [lesson('l1', 'ΜΑΘΗΜΑ-ΝΙΚΟΥ', { sources: [line], extra: '{"from":"<@null>"}' })],
      [turn('r2', 1)],
      { lessons: { budgetTokens: 100_000 } },
      (world) => addSourceLine(world.db, { id: line, place: LESSONS_AGORA, author: 'fake:4242', audience: GROUP })
    );
    const entry = peopleOf(request).find((one) => one.includes('Νίκος')) ?? '';
    const handle = HANDLE.exec(entry.split('\n')[0] ?? '')?.[0] ?? '';
    assert.match(handle, HANDLE, 'Νίκος has an entry in <people>');
    assert.ok(lineWith(lessonsOfWorld(request), 'ΜΑΘΗΜΑ-ΝΙΚΟΥ').includes(handle), lessonsOfWorld(request));
  });

  test('a lesson about the persona, written by their memory session, shows with its teacher who has an entry in <people>', async () => {
    // Bug: the block reads the lessons of places only, so what the persona learned about themselves from people never shows, and with
    // no teacher read its person has no entry. The claim has the subject `self`, no weight and a source line by Νίκος.
    const line = 'src:fake:n1:1:seen';
    const [request = ''] = await inRoom(
      [lesson('l1', 'ΜΑΘΗΜΑ-ΓΙΑ-ΕΜΕΝΑ', { subject: 'self', how: 'saw', weight: null, sources: [line] })],
      [turn('r2', 1)],
      { lessons: { budgetTokens: 100_000 } },
      (world) => addSourceLine(world.db, { id: line, place: LESSONS_AGORA, author: 'fake:4242', audience: GROUP })
    );
    const entry = peopleOf(request).find((one) => one.includes('Νίκος')) ?? '';
    const handle = HANDLE.exec(entry.split('\n')[0] ?? '')?.[0] ?? '';
    assert.match(handle, HANDLE, 'Νίκος has an entry in <people>');
    assert.ok(lineWith(lessonsOfWorld(request), 'ΜΑΘΗΜΑ-ΓΙΑ-ΕΜΕΝΑ').includes(handle), lessonsOfWorld(request));
  });

  test('a change under a direct chat the turn may not read lists nobody in a group', async () => {
    // Bug: the block is read under a context wider than the turn's, so what the persona feels in a private chat shows in a room.
    const [request = ''] = await inRoom([], [turn('r2', 1)], FELT(6), (world) => {
      feelings([[NIKOS, 50]])(world);
      feelings([[LESSONS_ZOE, -80]], { dm: ZOE_DM, iface: 'fake', person: LESSONS_ZOE })(world);
    });
    const body = attitudesOf(request);
    assert.ok(body.includes(handleIn(NIKOS)), body);
    assert.ok(!body.includes(handleIn(LESSONS_ZOE)), body);
  });
});
