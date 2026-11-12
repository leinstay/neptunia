// Tests for what src/memory/db/frame-reads.ts reads of a place's claims for a request on the turn frame (spec
// 2026-11-12-what-the-frame-dropped, slice 1). Signatures:
//   lessonsOf(db: Db, ctx: Context): Array<Lesson>
//   type Lesson = { text: string; teacher: string | null }, `teacher` the person id that taught it (`from_person`)
//   placeFieldsOf(db, ctx, placeId) gains the field `injokes`: the in-jokes of the place the context reads, in one string
// Slice 3 adds the read of the people she feels most strongly about (spec 2026-11-12-what-the-frame-dropped):
//   strongestAttitudesOf(db: Db, ctx: Context, limit: number): Array<StrongAttitude>
//   type StrongAttitude = { person: string; score: number; at: string }
// `lessonsOf` reads the claims of kind `lesson` of every place whose audience the context may read, retired ones left out,
// ranked as the old `<about_chat>` ranked them (src/memory/ranking.ts, `rank`): log2(weight + 0.5) plus the moment last seen
// over a half-life of 720 days (`memory.learnedHalfLifeDays`), the best first. Synthetic SQLite rows over the mind-world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lessonsOf, placeFieldsOf, strongestAttitudesOf } from '../src/memory/db/frame-reads.ts';
import { dmContext, groupContext } from '../src/memory/db/scope.ts';
import { addAttitude, addDm, addPerson, noteInterface, openWorld, rootId } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import type { Audience } from './fixtures/memory-db/mind-world.ts';
import { addPlaceClaim, addSourceLine } from './fixtures/memory-db/place-claims.ts';

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
  // Bug: the new reader sorts by weight alone, by recency alone or by the order of storage, so what people taught her most
  // often and lately is cut first when the budget runs out.
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
  // Bug: the reader keeps to the root of the turn's place, as the old block did, so what a person taught her elsewhere
  // never follows her.
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
// `claim_sources.position`) that the context may read and that a person wrote and she did not, else none. A stored
// `extra.from` such as the broken token `<@null>` names nobody.
const LINE_BY_NIKOS = 'src:fake:n1:1:seen';
const LINE_BY_ZOE = 'src:fake:z1:1:seen';
const LINE_BY_HER = 'src:fake:h1:1:said';

/** The lesson world with Nikos, and one source line each of Nikos, Zoe and her, all in the group. */
function teacherWorld(): { world: World; zoeDm: string } {
  const made = lessonWorld();
  const { db } = made.world;
  addPerson(db, { id: NIKOS, accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Nikos'] }] });
  addSourceLine(db, { id: LINE_BY_NIKOS, place: AGORA, author: 'fake:4242', audience: GROUP });
  addSourceLine(db, { id: LINE_BY_ZOE, place: AGORA, author: 'fake:5678', audience: GROUP });
  addSourceLine(db, { id: LINE_BY_HER, place: AGORA, author: 'self', audience: GROUP });
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

test('her own source line is skipped and the next line by a person names the teacher', () => {
  // Bug: the first source line names the teacher whoever wrote it, and she becomes the teacher of what she was told.
  const { world } = teacherWorld();
  try {
    addPlaceClaim(world.db, {
      id: 'l1',
      place: AGORA,
      kind: 'lesson',
      text: 'told',
      audience: GROUP,
      sources: [LINE_BY_HER, LINE_BY_NIKOS],
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

test('a lesson whose only source line is hers has no teacher', () => {
  // Bug: she is named as the teacher of a lesson, and her own handle stands in `<lessons>`.
  const { world } = teacherWorld();
  try {
    addPlaceClaim(world.db, {
      id: 'l1',
      place: AGORA,
      kind: 'lesson',
      text: 'told',
      audience: GROUP,
      sources: [LINE_BY_HER],
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

// Her memory session writes lessons about herself: the subject `self` (`subject_id` the persona's id), the weight left
// null, `how` one of `taught`, `saw`, `said` and `inferred`, under a group or a direct chat's audience. They are what she
// learned about herself from everyone, and `lessonsOf` reads them beside the lessons of a place.
const SELF_LESSON = { subject: 'self', how: 'saw' } as const;

test('a lesson about herself comes back beside the lessons of a place', () => {
  // Bug: the reader takes claims whose subject is a place, so the lessons her memory session wrote about herself never show.
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
  // Bug: a null weight ranks as 0 (log2(0.5) is -1), and every lesson her session wrote sinks below the weakest of a place.
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

test('a lesson about herself under a direct chat audience shows in that chat and not in a group', () => {
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

test('a lesson about herself under a direct chat audience stays out of a group read', () => {
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

test('a lesson about herself is taught by the person who wrote its source line', () => {
  // Bug: the teacher of a `self` lesson is read from `from_person` alone, which her session leaves null.
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

// ---- The people she feels most strongly about --------------------------------------------------------------------
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
  // Bug: the list is sorted by the signed score, so the people she dislikes most stand last instead of first.
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
  // Bug: the read has no audience, so what her feeling was in a private chat shows in a group: the first has only a private
  // change, the second has a group change and a newer private one.
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
