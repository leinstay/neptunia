// src/turn/request/meanwhile.ts: `<meanwhile>`, her last messages in other places with a few lines around each, as
// background (plan 2026-11-06-turn-frame, slice 4 (a) and "The ordinary turn"). Contract:
//   meanwhileOf(reads, frame: Frame, settings: { messages: number; around: number }, labels: Labels,
//     nameOf: (id: string) => string | null): string
// `reads` is the shape of tests/fixtures/meanwhile-reads.ts. Her last `messages` lines outside the current place, each
// with `around` lines before and after, overlapping windows merged, under the path of their place. A one-to-one chat's
// lines only at the command line (the place `cli:dm:owner`) or on a turn that is nowhere; a group's lines always.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameOf } from '../src/turn/request/frame.ts';
import type { Frame } from '../src/turn/request/frame.ts';
import { meanwhileOf, meanwhileText, meanwhileWindows } from '../src/turn/request/meanwhile.ts';
import { formatDate } from '../src/format.ts';
import { DM, DM_CHAIN, PARTNER, frameInput } from './fixtures/frame-input.ts';
import { line, meanwhileReads } from './fixtures/meanwhile-reads.ts';
import type { FakePlace } from './fixtures/meanwhile-reads.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';
import { linesAroundOf, ownLinesOf } from '../src/memory/db/frame-reads.ts';
import { linkedDmScopes } from '../src/memory/db/person-links.ts';
import { issueContext } from '../src/memory/db/scope.ts';
import {
  addDm,
  addLine,
  addPerson,
  addRoom,
  noteInterface,
  openWorld,
  rootId,
} from './fixtures/memory-db/mind-world.ts';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const MIN = 60_000;
/** The owner's values for `context.meanwhile`. */
const SETTINGS = { messages: 8, around: 2 };

const nameOf = (id: string): string | null => ({ '111': 'Ελένη', '222': 'Νίκος' })[id] ?? null;

const GROUP_FRAME = frameOf(frameInput({ now: NOW }));
const DM_FRAME = frameOf(frameInput({ now: NOW, chain: DM_CHAIN, dm: DM }));
const CLI_FRAME = frameOf(
  frameInput({
    now: NOW,
    interface: 'cli',
    chain: [{ id: 'cli:dm:owner', kind: 'dm', name: null }],
    dm: { word: 'private', nativeId: 'owner', partner: PARTNER },
  })
);

/** A room with one line of hers at `at` and nothing else. */
function room(id: string, name: string, text: string, at = NOW - 30 * MIN): FakePlace {
  return { id, path: ['fake', 'Αγορά', name], dm: false, lines: [line(id, `${id}:1`, at, null, text)] };
}

function dm(id: string, text: string): FakePlace {
  return { id, path: ['fake', 'private', '5678'], dm: true, lines: [line(id, `${id}:1`, NOW - 20 * MIN, null, text)] };
}

const render = (places: Array<FakePlace>, frame: Frame, settings = SETTINGS): string =>
  meanwhileOf(meanwhileReads(places), frame, settings, shippedLabels, nameOf);

test('<meanwhile> holds no line of the current place', () => {
  // Bug: her last line here repeats in the background and she answers it a second time.
  const text = render(
    [room('place:room', 'γενικά', 'ΓΡΑΜΜΗ-ΕΔΩ'), room('place:club', 'λέσχη', 'ΓΡΑΜΜΗ-ΛΕΣΧΗ')],
    GROUP_FRAME
  );
  assert.ok(text.includes('ΓΡΑΜΜΗ-ΛΕΣΧΗ'));
  assert.ok(!text.includes('ΓΡΑΜΜΗ-ΕΔΩ'));
});

test('a one-to-one chat shows the lines of groups and none of another one-to-one chat', () => {
  // Bug: what she said to one person in private reaches the background of a chat with another.
  const text = render([room('place:club', 'λέσχη', 'ΓΡΑΜΜΗ-ΛΕΣΧΗ'), dm('fake:dm:5678', 'ΓΡΑΜΜΗ-ΙΔΙΩΤΙΚΗ')], DM_FRAME);
  assert.ok(text.includes('ΓΡΑΜΜΗ-ΛΕΣΧΗ'));
  assert.ok(!text.includes('ΓΡΑΜΜΗ-ΙΔΙΩΤΙΚΗ'));
});

test('the command line shows the lines of one-to-one chats too', () => {
  // Bug: the owner's session, which reads everything, loses her private chats from the background.
  const text = render([room('place:club', 'λέσχη', 'ΓΡΑΜΜΗ-ΛΕΣΧΗ'), dm('fake:dm:5678', 'ΓΡΑΜΜΗ-ΙΔΙΩΤΙΚΗ')], CLI_FRAME);
  assert.ok(text.includes('ΓΡΑΜΜΗ-ΛΕΣΧΗ'));
  assert.ok(text.includes('ΓΡΑΜΜΗ-ΙΔΙΩΤΙΚΗ'));
});

test('the windows of two of her messages a minute apart merge into one, each line once under one path', () => {
  // Bug: the shared lines repeat and the place's path heads two windows.
  const at = NOW - 30 * MIN;
  const club: FakePlace = {
    id: 'place:club',
    path: ['fake', 'Αγορά', 'λέσχη'],
    dm: false,
    lines: [
      line('place:club', 'c1', at - 2 * MIN, '111', 'ΠΡΙΝ-ΔΥΟ'),
      line('place:club', 'c2', at - MIN, '222', 'ΠΡΙΝ-ΕΝΑ'),
      line('place:club', 'c3', at, null, 'ΔΙΚΗ-ΤΗΣ-ΠΡΩΤΗ'),
      line('place:club', 'c4', at + MIN, null, 'ΔΙΚΗ-ΤΗΣ-ΔΕΥΤΕΡΗ'),
      line('place:club', 'c5', at + 2 * MIN, '111', 'ΜΕΤΑ-ΕΝΑ'),
      line('place:club', 'c6', at + 3 * MIN, '222', 'ΜΕΤΑ-ΔΥΟ'),
    ],
  };
  const text = render([club], GROUP_FRAME);
  for (const value of ['ΠΡΙΝ-ΔΥΟ', 'ΠΡΙΝ-ΕΝΑ', 'ΔΙΚΗ-ΤΗΣ-ΠΡΩΤΗ', 'ΔΙΚΗ-ΤΗΣ-ΔΕΥΤΕΡΗ', 'ΜΕΤΑ-ΕΝΑ', 'ΜΕΤΑ-ΔΥΟ'])
    assert.equal(text.split(value).length - 1, 1, `${value} once`);
  assert.equal(text.split('λέσχη').length - 1, 1);
});

test('only her last `messages` lines are shown, the older ones left out', () => {
  // Bug: the setting is not read and the block grows with every place she wrote in.
  const places = Array.from({ length: 10 }, (_, i) =>
    room(`place:r${i}`, `δωμάτιο-${i}`, `ΓΡΑΜΜΗ-${String(i).padStart(2, '0')}`, NOW - (60 - i) * MIN)
  );
  const text = render(places, GROUP_FRAME, { messages: 8, around: 0 });
  assert.ok(!text.includes('ΓΡΑΜΜΗ-00') && !text.includes('ΓΡΑΜΜΗ-01'));
  for (let i = 2; i < 10; i += 1) assert.ok(text.includes(`ΓΡΑΜΜΗ-${String(i).padStart(2, '0')}`));
});

test('no line of hers elsewhere renders no text', () => {
  // Bug: an empty block with its heading reaches the request.
  assert.equal(render([], GROUP_FRAME).trim(), '');
});

// `<meanwhile>` of a reply in a direct chat over the stored lines (src/turn/request/meanwhile.ts over the reads of
// src/memory/db/frame-reads.ts, plan 2026-11-06-turn-frame, slice 5, and decision 9): a direct chat's rows are read in
// that chat and in the chats of the same person's linked accounts, so the background of a direct chat holds the groups
// and that person's other chat with her, never another person's. The reads apply the turn's context; meanwhileOf
// keeps out only what the frame may not show. The command line's case, every place, is in
// tests/request-meanwhile.test.ts.

const NOW_READS = Date.parse('2026-11-02T12:00:00.000Z');
const iso = (at: number): string => new Date(at).toISOString();
const ZOE = 'person:zoe';
const NIKOS = 'person:nikos';

test('a direct chat reply shows the groups and the same person linked chat, and no other person chat', () => {
  // Bug: the frame drops every one-to-one line in a direct chat, so what she told this person elsewhere is lost, or
  // the scope lets another person's chat into the background.
  const w = openWorld();
  try {
    noteInterface(w, 'fake', [{ id: 'g1', name: 'Αγορά' }]);
    noteInterface(w, 'tele', [{ id: 't1', name: 'Νησί' }]);
    const garden = addRoom(w.db, { iface: 'fake', native: 'c2', root: rootId('fake', 'g1'), name: 'κήπος' });
    addPerson(w.db, {
      id: ZOE,
      accounts: [
        { id: 'fake:5678', iface: 'fake', native: '5678', names: ['Ζωή'] },
        { id: 'tele:9999', iface: 'tele', native: '9999', names: ['Zoé'] },
      ],
    });
    addPerson(w.db, { id: NIKOS, accounts: [{ id: 'fake:4444', iface: 'fake', native: '4444', names: ['Νίκος'] }] });
    const here = addDm(w.db, { iface: 'fake', native: '5678', person: ZOE, account: 'fake:5678' });
    const linked = addDm(w.db, { iface: 'tele', native: '9999', person: ZOE, account: 'tele:9999' });
    const other = addDm(w.db, { iface: 'fake', native: '4444', person: NIKOS, account: 'fake:4444' });
    addLine(w.db, {
      id: 'g1',
      iface: 'fake',
      place: garden,
      author: 'self',
      text: 'ΣΤΟΝ-ΚΗΠΟ',
      at: iso(NOW_READS - 50 * MIN),
    });
    addLine(w.db, {
      id: 'l1',
      iface: 'tele',
      place: linked,
      author: 'self',
      text: 'ΣΤΗ-ΖΩΗ-ΑΛΛΟΥ',
      at: iso(NOW_READS - 40 * MIN),
      audience: { dm: linked, iface: 'tele', person: ZOE },
    });
    addLine(w.db, {
      id: 'o1',
      iface: 'fake',
      place: other,
      author: 'self',
      text: 'ΣΤΟΝ-ΝΙΚΟ',
      at: iso(NOW_READS - 30 * MIN),
      audience: { dm: other, iface: 'fake', person: NIKOS },
    });
    // The context as the memory service issues it (src/memory/db/service.ts#linkedContext): the person's other chats.
    const issued = issueContext({
      kind: 'dm',
      iface: 'fake',
      person: ZOE,
      place: here,
      now: () => NOW_READS,
      newId: () => 'ctx:dm',
    });
    const ctx = { ...issued, linked: linkedDmScopes(w.db, ZOE, here) };
    const frame = frameOf(
      frameInput({
        now: NOW_READS,
        chain: [{ id: here, kind: 'dm', name: null }],
        dm: {
          word: 'private',
          nativeId: '5678',
          partner: { personId: ZOE, accountId: 'fake:5678', nativeId: '5678', name: 'Ζωή' },
        },
      })
    );
    const reads = {
      ownMessages: (limit: number) => ownLinesOf(w.db, ctx, here, limit),
      around: (placeId: string, at: number, count: number) => linesAroundOf(w.db, ctx, placeId, at, count),
    };
    const text = meanwhileOf(reads, frame, { messages: 8, around: 2 }, shippedLabels, () => null);
    assert.ok(text.includes('ΣΤΟΝ-ΚΗΠΟ'), 'a group');
    assert.ok(text.includes('ΣΤΗ-ΖΩΗ-ΑΛΛΟΥ'), "the same person's linked chat");
    assert.ok(!text.includes('ΣΤΟΝ-ΝΙΚΟ'), "another person's chat");
  } finally {
    w.close();
  }
});

/** A room with one line of hers that holds the media `media` and the text `text`. */
function roomWithMedia(text: string, media: ReadonlyArray<{ kind: string; text: string | null }>): FakePlace {
  return {
    id: 'place:club',
    path: ['fake', 'Αγορά', 'λέσχη'],
    dm: false,
    lines: [line('place:club', 'c1', NOW - 30 * MIN, null, text, media)],
  };
}

test('a post of hers that is only a picture shows its description in the block', () => {
  // Bug: a picture-only post has empty text and was left out, so the block read as if she had not posted there.
  const text = render([roomWithMedia('', [{ kind: 'image', text: 'a white rabbit in a garden' }])], GROUP_FRAME);
  assert.ok(text.includes('a white rabbit in a garden'), text);
});

test('a post of hers with text and a picture shows both', () => {
  // Bug: the picture's description replaced the post's text, or the text hid the picture.
  const text = render(
    [roomWithMedia('ΛΕΞΕΙΣ-ΜΑΖΙ', [{ kind: 'image', text: 'a white rabbit in a garden' }])],
    GROUP_FRAME
  );
  assert.ok(text.includes('ΛΕΞΕΙΣ-ΜΑΖΙ'), text);
  assert.ok(text.includes('a white rabbit in a garden'), text);
});

// The owner's decision of 2026-11-11 (a place reads in words): a window's head names its place the way every request
// does, and the window dates each day. The window of these tests is built over the fake reads, which carry the place's
// chain, its interface and the interface's own names.
const NAMES = { interface: 'Agora Net', nouns: { server: 'realm', channel: 'room' }, dm: 'private talk' };
const REFS = { handleOf: (key: string) => `u${key.length}x`, mention: () => 'someone' };

/** The text of `<meanwhile>` over one place of the fake with handle `handle`, as the reader renders its windows. */
function textOf(place: FakePlace, frame: Frame = GROUP_FRAME, handle: string | null = 'cab12'): string {
  const windows = meanwhileWindows(meanwhileReads([place]), frame, SETTINGS);
  return meanwhileText(windows, frame, shippedLabels, nameOf, () => handle, REFS);
}

test('the head of a channel window reads the handle, the channel, its root and the interface in words, and holds no >', () => {
  // Bug: the head ran the names together as `iface > Root > chat`, root first, so a talk of one place read as a talk of
  // another and a name read as part of a path.
  const alpha: FakePlace = {
    id: 'place:alpha',
    path: ['agora', 'Beta', 'alpha'],
    dm: false,
    iface: 'agora',
    names: NAMES,
    chain: [
      { id: 'place:alpha', kind: 'channel', name: 'alpha' },
      { id: 'place:beta', kind: 'server', name: 'Beta' },
    ],
    lines: [line('place:alpha', 'a1', NOW - 30 * MIN, null, 'ΓΡΑΜΜΗ')],
  };
  const head =
    textOf(alpha)
      .split('\n')
      .find((one) => one.startsWith('#')) ?? '';
  assert.ok(head.startsWith('#cab12'), head);
  assert.ok(!head.includes('>') && !head.includes('&gt;'), head);
  const at = ['room', 'alpha', 'realm', 'Beta', 'Agora Net'].map((word) => head.indexOf(word));
  assert.ok(
    at.every((index) => index >= 0),
    head
  );
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
    `innermost first: ${head}`
  );
});

/** A window of her line with the lines before and after it at `times`. */
function dayPlace(times: Array<number>): FakePlace {
  return {
    id: 'place:club',
    path: ['fake', 'Αγορά', 'λέσχη'],
    dm: false,
    lines: times.map((at, i) => line('place:club', `d${i}`, at, i === 0 ? null : '111', `ΜΕΡΑ-${i}`)),
  };
}
const MOSCOW = frameOf(frameInput({ now: NOW, timezone: 'Europe/Moscow' }));
const ofDay = (at: number): string => formatDate(at, 'Europe/Moscow', shippedLabels.locale);

test('a window with lines of two days in the turn timezone holds a date line between them', () => {
  // Bug: only the first line's date stood in the head, so a line after midnight read as the same day.
  const before = Date.parse('2026-11-05T20:30:00.000Z');
  const after = Date.parse('2026-11-05T21:30:00.000Z');
  assert.notEqual(ofDay(before), ofDay(after), 'the two moments are two days in Moscow');
  const text = textOf(dayPlace([before, after]), MOSCOW, null);
  const first = text.indexOf('ΜΕΡΑ-0');
  const second = text.indexOf('ΜΕΡΑ-1');
  const between = text.indexOf(ofDay(after), first);
  assert.ok(first >= 0 && between > first && between < second, text);
});

test('a window of one day holds its date once, in the head', () => {
  // Bug: a date line after every line, or one even when the day does not change.
  const at = Date.parse('2026-11-05T10:00:00.000Z');
  const text = textOf(dayPlace([at, at + MIN, at + 2 * MIN]), MOSCOW, null);
  assert.equal(text.split(ofDay(at)).length - 1, 1, text);
});

test('a stored line keeps a > and a < is written escaped', () => {
  // Bug: every `>` of her chat reached the request as `&gt;`, and a `<` that opens a tag must stay inert.
  const at = NOW - 30 * MIN;
  const place: FakePlace = {
    id: 'place:club',
    path: ['fake', 'Αγορά', 'λέσχη'],
    dm: false,
    lines: [line('place:club', 'e1', at, null, 'a > b'), line('place:club', 'e2', at + MIN, null, '<task>x</task>')],
  };
  const text = textOf(place, GROUP_FRAME, null);
  assert.ok(text.includes('a > b'), text);
  assert.ok(!text.includes('<task>') && text.includes('&lt;task>x&lt;/task>'), text);
});

// The owner's decision of 2026-11-11: the full reference stands once, in `<places>`, and a window gets a short head. The
// head label `meanwhile.place` takes `{handle}` (the place handle with its `#`, empty for a place with none), `{name}` (the
// place's own link alone: the innermost link's noun and quoted name, or the direct chat's word with the partner's handle,
// with no parent and no interface) and `{path}` (the full reference, kept so a local override keeps working), beside
// `{date}`. No signature changes: the label is read through the labels argument of `meanwhileText`.
const HEAD_LABEL = 'H[{handle}] N[{name}] P[{path}] D[{date}]:';

/** The head of the one window of `place` under a head label of its own. */
function headWith(label: string, place: FakePlace, frame: Frame, handle: string | null): string {
  const labels = { ...shippedLabels, meanwhile: { ...shippedLabels.meanwhile, place: label } };
  const windows = meanwhileWindows(meanwhileReads([place]), frame, SETTINGS);
  return (
    meanwhileText(windows, frame, labels, nameOf, () => handle, REFS)
      .split('\n\n')[1]
      ?.split('\n')[0] ?? ''
  );
}

/** The three placeholders of `HEAD_LABEL` as a head filled them. */
function partsOf(head: string): { handle: string; name: string; path: string } {
  const found = /^H\[(.*?)\] N\[(.*?)\] P\[(.*?)\] D\[/.exec(head);
  return { handle: found?.[1] ?? '?', name: found?.[2] ?? '?', path: found?.[3] ?? '?' };
}

const ALPHA: FakePlace = {
  id: 'place:alpha',
  path: ['agora', 'Beta', 'alpha'],
  dm: false,
  iface: 'agora',
  names: NAMES,
  chain: [
    { id: 'place:alpha', kind: 'channel', name: 'alpha' },
    { id: 'place:beta', kind: 'server', name: 'Beta' },
  ],
  lines: [line('place:alpha', 'a1', NOW - 30 * MIN, null, 'ΓΡΑΜΜΗ')],
};

test('a head label fills {handle}, {name} and {path} for a channel: the handle, its own link alone, the whole reference', () => {
  // Bug: the full reference stood over every window, so one place read in full each time and the head was long.
  const head = headWith(HEAD_LABEL, ALPHA, GROUP_FRAME, 'cab12');
  const { handle, name, path } = partsOf(head);
  assert.equal(handle, '#cab12', head);
  assert.ok(name.includes('room') && name.includes('"alpha"'), head);
  assert.ok(!/realm|Beta|Agora Net/.test(name), `no parent and no interface: ${head}`);
  assert.ok(
    ['alpha', 'Beta', 'Agora Net'].every((word) => path.includes(word)),
    head
  );
});

test('a head label fills {handle} with nothing for a place with no handle', () => {
  const head = headWith(HEAD_LABEL, ALPHA, GROUP_FRAME, null);
  const { handle, name } = partsOf(head);
  assert.equal(handle, '', head);
  assert.ok(name.includes('"alpha"'), head);
});

test('a head label fills {name} for a direct chat as its word with the partner handle, and no interface', () => {
  // Bug: a direct chat's short head carried the interface and an unnamed place, or lost the partner.
  const zoe: FakePlace = {
    id: 'tele:dm:zoe',
    path: ['tele', 'private', '1234'],
    dm: true,
    iface: 'tele',
    names: NAMES,
    partner: 'person:zoe',
    partnerKey: 'person:zoe',
    lines: [line('tele:dm:zoe', 'z1', NOW - 30 * MIN, null, 'ΙΔΙΩΤΙΚΗ')],
  };
  const cli = frameOf(frameInput({ now: NOW, interface: 'cli', chain: DM_CHAIN, dm: DM }));
  const head = headWith(HEAD_LABEL, zoe, cli, 'cd777');
  const { handle, name } = partsOf(head);
  assert.equal(handle, '#cd777', head);
  assert.ok(name.includes('private talk') && name.includes(`@${REFS.handleOf('person:zoe')}`), head);
  assert.ok(!name.includes('Agora Net'), head);
});

test('a head label that uses only {path} and {date} still renders the reference once and the date', () => {
  // Bug: a local override of the head label stopped working when the placeholders changed.
  const head = headWith('{path}, {date}:', ALPHA, GROUP_FRAME, 'cab12');
  assert.ok(head.includes('#cab12'), head);
  const at = ['alpha', 'Beta', 'Agora Net'].map((word) => head.indexOf(word));
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
    head
  );
  assert.ok(head.endsWith(`${formatDate(NOW - 30 * MIN, 'UTC', shippedLabels.locale)}:`), head);
});
