// Tests for src/turn/request/meanwhile.ts: `<meanwhile>`, the persona's last messages in other places with a few lines
// around each, as background. Contract:
//   meanwhileText(meanwhileWindows(reads, frame: Frame, settings: { messages: number; around: number }), frame,
//     labels: Labels, nameOf: (id: string) => string | null): string
// `reads` is the shape of tests/fixtures/meanwhile-reads.ts. The persona's last `messages` lines outside the current
// place, each with `around` lines before and after, overlapping windows merged, under the path of their place. A
// one-to-one chat's lines only at the command line (the place `cli:dm:owner`) or on a turn that is nowhere; a group's
// lines always.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { frameOf } from '../../../../src/turn/request/frame.ts';
import type { Frame, FrameParty } from '../../../../src/turn/request/frame.ts';
import { meanwhileSettingsOf, meanwhileText, meanwhileWindows } from '../../../../src/turn/request/meanwhile.ts';
// A namespace import, so the file loads while `meanwhileReadsOf` is still missing and only its test fails.
import * as meanwhileModule from '../../../../src/turn/request/meanwhile.ts';
import { formatDate } from '../../../../src/format.ts';
import { DM, DM_CHAIN, frameInput, PARTNER, ROOM_CHAIN, wakeInput } from '../../../fixtures/frame-input.ts';
import { line, meanwhileReads } from '../../../fixtures/meanwhile-reads.ts';
import type { FakePlace } from '../../../fixtures/meanwhile-reads.ts';
import { shippedLabels } from '../../../fixtures/shipped-labels.ts';
import { frameReadsOver, linesAroundOf, ownLinesOf } from '../../../../src/memory/db/frame-reads.ts';
import type { Db, Statement } from '../../../../src/memory/db/types.ts';
import { linkedDmScopes } from '../../../../src/memory/db/person-links.ts';
import { internalContext, issueContext } from '../../../../src/memory/db/scope.ts';
import {
  addDm,
  addLine,
  addPerson,
  addRoom,
  noteInterface,
  openWorld,
  rootId,
  type World,
} from '../../../fixtures/memory-db/mind-world.ts';
import { handleOf } from '../../../../src/behavior/handles.ts';
import { userText as contentText } from '../../../../src/behavior/prompt.ts';
import type { Lookup } from '../../../../src/turn/calls.ts';
import { buildRequest, type Built } from '../../../fixtures/built-request.ts';
import { mindOfEntries, personEntry, placeEntry } from '../../../fixtures/mind-entries.ts';
import { OWNER_PERSON } from '../../../fixtures/owner-accounts.ts';
import {
  baseInput,
  fakeConfig,
  fakePrompts,
  makeMessage,
  MIN as PROMPT_READER_MIN,
  NOW as PROMPT_READER_NOW,
} from '../../../fixtures/prompt-rig.ts';
import {
  blockOf,
  CLI_CHAT,
  replyRun,
  type ReplyRun,
  type ReplyStep,
  serviceTurn,
  serviceWake,
  serviceWorld,
  TEXT,
  TURN_NOW,
} from '../../../fixtures/service-turn.ts';
import { useIface } from '../../../fixtures/turn-world.ts';

/** The body of `<meanwhile>` as the request builds it: the windows of the persona's lines elsewhere, worded. */
const meanwhileOf = (
  reads: Parameters<typeof meanwhileWindows>[0],
  frame: Frame,
  settings: Parameters<typeof meanwhileWindows>[2],
  labels: Parameters<typeof meanwhileText>[2],
  nameOf: Parameters<typeof meanwhileText>[3]
): string => meanwhileText(meanwhileWindows(reads, frame, settings), frame, labels, nameOf);

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const MIN = 60_000;
/** Values for `context.meanwhile`. */
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

/** A room with one line of the persona's at `at` and nothing else. */
function room(id: string, name: string, text: string, at = NOW - 30 * MIN): FakePlace {
  return { id, path: ['fake', 'Αγορά', name], dm: false, lines: [line(id, `${id}:1`, at, null, text)] };
}

function dm(id: string, text: string): FakePlace {
  return { id, path: ['fake', 'private', '5678'], dm: true, lines: [line(id, `${id}:1`, NOW - 20 * MIN, null, text)] };
}

const render = (places: Array<FakePlace>, frame: Frame, settings = SETTINGS): string =>
  meanwhileOf(meanwhileReads(places), frame, settings, shippedLabels, nameOf);

test('<meanwhile> holds no line of the current place', () => {
  // Bug: the persona's last line here repeats in the background and they answer it a second time.
  const text = render(
    [room('place:room', 'γενικά', 'ΓΡΑΜΜΗ-ΕΔΩ'), room('place:club', 'λέσχη', 'ΓΡΑΜΜΗ-ΛΕΣΧΗ')],
    GROUP_FRAME
  );
  assert.ok(text.includes('ΓΡΑΜΜΗ-ΛΕΣΧΗ'));
  assert.ok(!text.includes('ΓΡΑΜΜΗ-ΕΔΩ'));
});

test('a one-to-one chat shows the lines of groups and none of another one-to-one chat', () => {
  // Bug: what the persona said to one person in private reaches the background of a chat with another.
  const text = render([room('place:club', 'λέσχη', 'ΓΡΑΜΜΗ-ΛΕΣΧΗ'), dm('fake:dm:5678', 'ΓΡΑΜΜΗ-ΙΔΙΩΤΙΚΗ')], DM_FRAME);
  assert.ok(text.includes('ΓΡΑΜΜΗ-ΛΕΣΧΗ'));
  assert.ok(!text.includes('ΓΡΑΜΜΗ-ΙΔΙΩΤΙΚΗ'));
});

test("with context.memory.openPrivate on, a group, another person's chat and a heartbeat show one-to-one lines", () => {
  // Bug: the background keeps splitting the persona's lines by place after the switch opened their memory in every
  // place.
  const places = [room('place:club', 'λέσχη', 'ΓΡΑΜΜΗ-ΛΕΣΧΗ'), dm('fake:dm:5678', 'ΓΡΑΜΜΗ-ΙΔΙΩΤΙΚΗ')];
  const heartbeat = frameOf(wakeInput('heartbeat'));
  for (const frame of [GROUP_FRAME, DM_FRAME, heartbeat]) {
    const config = (open: boolean) => ({ context: { meanwhile: SETTINGS, memory: { openPrivate: open } } });
    assert.ok(render(places, frame, meanwhileSettingsOf(config(true), frame)).includes('ΓΡΑΜΜΗ-ΙΔΙΩΤΙΚΗ'));
    assert.ok(!render(places, frame, meanwhileSettingsOf(config(false), frame)).includes('ΓΡΑΜΜΗ-ΙΔΙΩΤΙΚΗ'));
  }
});

test('the command line shows the lines of one-to-one chats too', () => {
  // Bug: the command line session, which reads everything, loses the persona's private chats from the background.
  const text = render([room('place:club', 'λέσχη', 'ΓΡΑΜΜΗ-ΛΕΣΧΗ'), dm('fake:dm:5678', 'ΓΡΑΜΜΗ-ΙΔΙΩΤΙΚΗ')], CLI_FRAME);
  assert.ok(text.includes('ΓΡΑΜΜΗ-ΛΕΣΧΗ'));
  assert.ok(text.includes('ΓΡΑΜΜΗ-ΙΔΙΩΤΙΚΗ'));
});

test("the windows of two of the persona's messages a minute apart merge into one, each line once under one path", () => {
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
  // A window's head is the place handle and the date, not the place's name, so the heads are counted by the handle.
  const text = textOf(club);
  for (const value of ['ΠΡΙΝ-ΔΥΟ', 'ΠΡΙΝ-ΕΝΑ', 'ΔΙΚΗ-ΤΗΣ-ΠΡΩΤΗ', 'ΔΙΚΗ-ΤΗΣ-ΔΕΥΤΕΡΗ', 'ΜΕΤΑ-ΕΝΑ', 'ΜΕΤΑ-ΔΥΟ'])
    assert.equal(text.split(value).length - 1, 1, `${value} once`);
  assert.equal(text.split('#cab12').length - 1, 1, 'one head');
});

test("only the persona's last `messages` lines are shown, the older ones left out", () => {
  // Bug: the setting is not read and the block grows with every place the persona wrote in.
  const places = Array.from({ length: 10 }, (_, i) =>
    room(`place:r${i}`, `δωμάτιο-${i}`, `ΓΡΑΜΜΗ-${String(i).padStart(2, '0')}`, NOW - (60 - i) * MIN)
  );
  const text = render(places, GROUP_FRAME, { messages: 8, around: 0 });
  assert.ok(!text.includes('ΓΡΑΜΜΗ-00') && !text.includes('ΓΡΑΜΜΗ-01'));
  for (let i = 2; i < 10; i += 1) assert.ok(text.includes(`ΓΡΑΜΜΗ-${String(i).padStart(2, '0')}`));
});

test("no line of the persona's elsewhere renders no text", () => {
  // Bug: an empty block with its heading reaches the request.
  assert.equal(render([], GROUP_FRAME).trim(), '');
});

// `<meanwhile>` of a reply in a direct chat over the stored lines (src/turn/request/meanwhile.ts over the reads of
// src/memory/db/frame-reads.ts): a direct chat's rows are read in that chat and in the chats of the same person's
// linked accounts, so the background of a direct chat holds the groups and that person's other chat with the persona,
// never another person's. The reads apply the turn's context; meanwhileOf keeps out only what the frame may not show.
// The command line's case, every place, is above.

const NOW_READS = Date.parse('2026-11-02T12:00:00.000Z');
const iso = (at: number): string => new Date(at).toISOString();
const ZOE = 'person:zoe';
const NIKOS = 'person:nikos';

test('a direct chat reply shows the groups and the same person linked chat, and no other person chat', () => {
  // Bug: the frame drops every one-to-one line in a direct chat, so what the persona told this person elsewhere is
  // lost, or the scope lets another person's chat into the background.
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

/** A room with one line of the persona's that holds the media `media` and the text `text`. */
function roomWithMedia(text: string, media: ReadonlyArray<{ kind: string; text: string | null }>): FakePlace {
  return {
    id: 'place:club',
    path: ['fake', 'Αγορά', 'λέσχη'],
    dm: false,
    lines: [line('place:club', 'c1', NOW - 30 * MIN, null, text, media)],
  };
}

test("a post of the persona's that is only a picture shows its description in the block", () => {
  // Bug: a picture-only post has empty text and was left out, so the block read as if the persona had not posted there.
  const text = render([roomWithMedia('', [{ kind: 'image', text: 'a white rabbit in a garden' }])], GROUP_FRAME);
  assert.ok(text.includes('a white rabbit in a garden'), text);
});

test("a post of the persona's with text and a picture shows both", () => {
  // Bug: the picture's description replaced the post's text, or the text hid the picture.
  const text = render(
    [roomWithMedia('ΛΕΞΕΙΣ-ΜΑΖΙ', [{ kind: 'image', text: 'a white rabbit in a garden' }])],
    GROUP_FRAME
  );
  assert.ok(text.includes('ΛΕΞΕΙΣ-ΜΑΖΙ'), text);
  assert.ok(text.includes('a white rabbit in a garden'), text);
});

// A place reads in words: a window's head names its place the way every request
// does, and the window dates each day. The window of these tests is built over the fake reads, which carry the place's
// chain, its interface and the interface's own names.
const NAMES = { interface: 'Agora Net', nouns: { server: 'realm', channel: 'room' }, dm: 'private talk' };
const REFS = { handleOf: (key: string) => `u${key.length}x`, mention: () => 'someone' };

/** The text of `<meanwhile>` over one place of the fake with handle `handle`, as the reader renders its windows. */
function textOf(place: FakePlace, frame: Frame = GROUP_FRAME, handle: string | null = 'cab12'): string {
  const windows = meanwhileWindows(meanwhileReads([place]), frame, SETTINGS);
  return meanwhileText(windows, frame, shippedLabels, nameOf, () => handle, REFS);
}

test('the shipped head of a channel window is its place handle and a colon, with no name of the place, its root or the interface', () => {
  // Bug: the head ran the names together as `iface > Root > chat`, so a talk of one place read as a talk of another.
  // The full reference stands once, in the place's entry of `<places>`, and the head over a window is the handle, a
  // colon and the date.
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
  assert.ok(head.startsWith('#cab12:'), head);
  for (const word of ['alpha', 'Beta', 'Agora Net', 'room', 'realm', '>']) assert.ok(!head.includes(word), head);
});

/** A window of the persona's line with the lines before and after it at `times`. */
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
  // Bug: every `>` of the persona's chat reached the request as `&gt;`, and a `<` that opens a tag must stay inert.
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

// The full reference stands once, in `<places>`, and a window gets a short head. The head label `meanwhile.place` takes
// `{handle}` (the place handle with its `#`, empty for a place with none), `{name}` (the place's own link alone: the
// innermost link's noun and quoted name, or the direct chat's word with the partner's handle, with no parent and no
// interface) and `{path}` (the full reference, kept so a local override keeps working), beside `{date}`. No signature
// changes: the label is read through the labels argument of `meanwhileText`.
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

test('a head label fills {handle} with the same text as {name} for a place with no handle', () => {
  // A head must name its place: with no handle the label's `{handle}` stands for the place's own name form, so a head
  // never opens with a bare colon.
  const head = headWith(HEAD_LABEL, ALPHA, GROUP_FRAME, null);
  const { handle, name } = partsOf(head);
  assert.ok(name.includes('"alpha"'), head);
  assert.equal(handle, name, head);
});

test('the shipped head of a window of a place with no handle opens with the place own name, not a colon', () => {
  // Bug: with no handle the head read `: <date>`, a head that names nothing.
  const own = partsOf(headWith(HEAD_LABEL, ALPHA, GROUP_FRAME, null)).name;
  const head = textOf(ALPHA, GROUP_FRAME, null).split('\n\n')[1]?.split('\n')[0] ?? '';
  assert.ok(!head.startsWith(':'), head);
  assert.ok(own !== '' && head.startsWith(own), head);
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

/** `db` with a count of the statements it runs. */
function counting(db: Db): { db: Db; ran: () => number } {
  let ran = 0;
  const prepare = (sql: string): Statement => {
    const statement = db.prepare(sql);
    return {
      get: (...params) => ((ran += 1), statement.get(...params)),
      all: (...params) => ((ran += 1), statement.all(...params)),
      run: (...params) => ((ran += 1), statement.run(...params)),
      iterate: (...params) => ((ran += 1), statement.iterate(...params)),
    };
  };
  return { db: { prepare, exec: (sql) => db.exec(sql) }, ran: () => ran };
}

/**
 * The bound on the statements of a placeless turn's `<meanwhile>` over 3 places, whatever the number of the persona's
 * lines: the persona's lines and their media (2), the mirrors of the persona's diary that those lines leave out (2:
 * whether the table is there, and its places), the path of each place (4 each, 12), and per place one read of every
 * window and one of their media (6).
 */
const SERVICE_MEANWHILE_STATEMENTS = 22;

test("a turn with no place reads the windows of the persona's last 100 lines in 3 places in statements that do not grow with those lines", () => {
  // Bug: each of the persona's 100 lines took two window reads and a media read, 300
  // statements that held the event loop for 7.4 s in each diary request.
  const world = openWorld();
  try {
    noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
    const rooms = ['c31', 'c32', 'c33'].map((native) =>
      addRoom(world.db, { iface: 'fake', native, root: rootId('fake', 'g1'), name: `room ${native}` })
    );
    const start = Date.parse('2026-11-05T00:00:00.000Z');
    for (let i = 0; i < 240; i += 1)
      addLine(world.db, {
        id: `src:fake:w${i}:1:seen`,
        iface: 'fake',
        place: rooms[i % 3] ?? '',
        author: i % 2 === 0 ? 'self' : 'account:fake:5150',
        text: `line ${i}`,
        at: new Date(start + i * MIN).toISOString(),
      });
    const { db, ran } = counting(world.db);
    const readsOf = meanwhileModule.meanwhileReadsOf;
    const reads = readsOf(
      frameReadsOver(
        () => db,
        () => ({})
      ),
      internalContext(),
      null
    );
    const windows = meanwhileWindows(reads, frameOf(wakeInput('heartbeat')), { messages: 100, around: 2 });
    assert.equal(windows.length, 3);
    assert.ok(ran() <= SERVICE_MEANWHILE_STATEMENTS, `${ran()} statements`);
  } finally {
    world.close();
  }
});

describe('an inner turn of a service', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test("<meanwhile> of a turn with no place holds the persona's lines from the groups of two interfaces and none from a direct chat", async () => {
    // Bug: a service reads `context.meanwhile.messages` (8 by default, 1 here) instead of serviceMessages, reads one
    // interface, or lets a private chat into a turn that needs none.
    // Changed: the wake was a heartbeat, which holds no `<meanwhile>` any more; an intention with no place keeps it.
    const run = await serviceTurn({ wake: serviceWake('intention_due'), answers: ['<skip/>'], chat: null });
    const meanwhile = blockOf(run.requests[0] ?? '', 'meanwhile');
    assert.ok(meanwhile.includes(TEXT.ownGarden), 'the room of the first interface');
    assert.ok(meanwhile.includes(TEXT.ownHarbour), 'the room of the second interface');
    assert.ok(!meanwhile.includes(TEXT.ownPrivate), 'no direct chat');
  });

  test('<meanwhile> of a service is cut at context.memory.serviceMessages', async () => {
    // Bug: the new setting is not read and a service shows every line of the persona's it can find.
    // Changed: the wake was a heartbeat, which holds no `<meanwhile>` any more; an intention with no place keeps it.
    const run = await serviceTurn({
      wake: serviceWake('intention_due'),
      answers: ['<skip/>'],
      chat: null,
      settings: { serviceMessages: 1 },
    });
    const meanwhile = blockOf(run.requests[0] ?? '', 'meanwhile');
    assert.ok(meanwhile.includes(TEXT.ownHarbour), "the persona's newest group line");
    assert.ok(!meanwhile.includes(TEXT.ownGarden), 'the older one is past the cut');
  });
});

const TIMEZONE = 'Europe/Moscow';

const ELENI = personEntry('111', 'Ελένη', { evidence: 'counterpart', relation: 'ΣΧΕΣΗ-ΕΛΕΝΗΣ' });

// A party carries the id the interface names them by (plan 2026-11-08 ids-by-links, slice 7b): the request no longer
// parses it out of the account id.
const AS_ELENI: FrameParty = { personId: ELENI.personId, accountId: 'fake:111', nativeId: '111', name: 'Ελένη' };

const CLUB = placeEntry('place:club', 'λέσχη', { purpose: 'ΣΚΟΠΟΣ-ΛΕΣΧΗΣ' });

const FRAME = frameOf(
  frameInput({
    now: PROMPT_READER_NOW,
    timezone: TIMEZONE,
    author: AS_ELENI,
    trigger: { messageId: 'm1', authorId: '111' },
  })
);

const WHEREABOUTS = { kind: 'place', iface: 'fake', private: false, chain: ROOM_CHAIN };

const CONTEXT = {
  meanwhile: { messages: 8, around: 2 },
  recall: { extractChars: 1200, maxItems: 6 },
};

const HISTORY = [
  makeMessage('m1', PROMPT_READER_NOW - PROMPT_READER_MIN, {
    authorId: '111',
    authorName: 'Ελένη',
    content: 'γεια σου',
  }),
];

const LOOKUP: Lookup = {
  turnId: 'turn:7',
  at: PROMPT_READER_NOW - 2 * PROMPT_READER_MIN,
  tool: 'memory.search',
  args: { query: 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ' },
  place: { id: 'place:room', path: ['fake', 'Αγορά', 'γενικά'] },
  status: 'ok',
  extract: 'ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ',
  sourceIds: ['src:fake:m50:1:seen'],
  anchorMessageIds: ['m1'],
};

/** The club with a line of the persona's among three of Eleni's. */
const CLUB_LINES: FakePlace = {
  id: 'place:club',
  path: ['fake', 'Αγορά', 'λέσχη'],
  dm: false,
  lines: [
    line('place:club', 'c1', PROMPT_READER_NOW - 40 * PROMPT_READER_MIN, '111', 'πρώτη'),
    line('place:club', 'c2', PROMPT_READER_NOW - 39 * PROMPT_READER_MIN, '111', 'δεύτερη'),
    line('place:club', 'c3', PROMPT_READER_NOW - 38 * PROMPT_READER_MIN, null, 'δική της'),
    line('place:club', 'c4', PROMPT_READER_NOW - 37 * PROMPT_READER_MIN, '111', 'τρίτη'),
  ],
};

const promptReaderNameOf = (id: string): string | null => (id === '111' ? 'Ελένη' : null);

function request(over: Record<string, unknown> = {}): Built {
  return buildRequest(
    baseInput({
      config: fakeConfig({ context: CONTEXT }),
      prompts: fakePrompts({ labels: shippedLabels }),
      frame: FRAME,
      whereabouts: WHEREABOUTS,
      history: HISTORY,
      trigger: HISTORY[0],
      triggerKind: 'mention',
      nameOf: promptReaderNameOf,
      mind: mindOfEntries({ people: [ELENI], places: [CLUB] }),
      lookups: [LOOKUP],
      myDay: ['09:00 έγραψα στη λέσχη'],
      meanwhileReads: meanwhileReads([CLUB_LINES]),
      ...over,
    })
  );
}

const userOf = ({ messages }: Built): string => contentText(messages[1].content);

/** The body of the root block `<tag>`, '' when absent. */
function block(built: Built, tag: string): string {
  return new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n</${tag}>$`, 'm').exec(userOf(built))?.[1] ?? '';
}

// A place reads in words and every chat has a handle. A place a request names carries
// its interface's id, its chain innermost first and the names its interface declared in its hello.
const PROMPT_READER_NAMES = { interface: 'Agora Net', nouns: { server: 'realm', channel: 'room' }, dm: 'direct talk' };

/** The line of a window head: the first of the windows of `<meanwhile>` that starts with a handle. */
const headLine = (built: Built): string =>
  block(built, 'meanwhile')
    .split('\n')
    .find((one) => one.startsWith('#')) ?? '';

/**
 * A handle and a colon open every entry, and the full reference stands once, in the
 * place's entry of `<places>`): a window's head is its place handle, a colon and the date, with none of the place's names.
 */
function assertShortHead(head: string, handle: string, names: ReadonlyArray<string>): void {
  assert.ok(head.startsWith(`#${handle}:`), head);
  for (const name of names) assert.ok(!head.includes(name), `${name} stands in ${head}`);
}

/** The frame of a direct chat with `partner` on `fake`. */
const dmFrame = (partner: FrameParty) =>
  frameOf(
    frameInput({
      now: PROMPT_READER_NOW,
      timezone: TIMEZONE,
      chain: DM_CHAIN,
      dm: { ...DM, partner },
      author: partner,
      trigger: { messageId: 'm1', authorId: partner.nativeId },
    })
  );

test('the window of a direct chat of the same person is headed by its place handle and a colon', () => {
  // Bug: a direct chat had no place handle, so a tool could not take it, and its head read `private` and a platform id.
  const zoe: FakePlace = {
    id: 'tele:dm:zoe',
    path: ['tele', 'private', '1234'],
    dm: true,
    iface: 'tele',
    names: PROMPT_READER_NAMES,
    partner: PARTNER.personId,
    partnerKey: PARTNER.personId,
    lines: [line('tele:dm:zoe', 'z1', PROMPT_READER_NOW - 30 * PROMPT_READER_MIN, null, 'ΙΔΙΩΤΙΚΗ')],
  };
  const built = request({
    frame: dmFrame(PARTNER),
    mind: mindOfEntries({}),
    history: [
      makeMessage('m1', PROMPT_READER_NOW - PROMPT_READER_MIN, {
        authorId: '1234',
        authorName: 'Zoé',
        content: 'γεια',
      }),
    ],
    meanwhileReads: meanwhileReads([zoe]),
    lookups: [],
    chatIdOf: (placeId: string) => (placeId === 'tele:dm:zoe' ? 'd-zoe' : null),
  });
  const handle = [...(built.channelHandles ?? [])].find(([, chat]) => chat === 'd-zoe')?.[0];
  assert.ok(handle, 'the direct chat has a place handle');
  const head = headLine(built);
  // The head is the handle and a colon, then the date. The partner and the interface
  // stand in the place's entry, not over the window.
  assertShortHead(head, handle, [`@${handleOf(PARTNER.personId)}`, 'Agora Net']);
  assert.doesNotMatch(head, /private|1234|>/);
});

test("the window of the command line's chat is headed by a place handle", () => {
  // Bug: the owner's command line chat had no place handle, so the persona could name every place but the one the owner talks in.
  const owner: FrameParty = { personId: 'person:owner', accountId: 'fake:777', nativeId: '777', name: 'Orestis' };
  const cli: FakePlace = {
    id: 'cli:dm:owner',
    path: ['cli', 'private', 'owner'],
    dm: true,
    iface: 'cli',
    names: { interface: 'Command line', nouns: {}, dm: 'terminal chat' },
    partner: owner.personId,
    partnerKey: owner.personId,
    lines: [line('cli:dm:owner', 'o1', PROMPT_READER_NOW - 30 * PROMPT_READER_MIN, null, 'ΤΕΡΜΑΤΙΚΟ')],
  };
  const built = request({
    frame: dmFrame(owner),
    mind: mindOfEntries({}),
    history: [
      makeMessage('m1', PROMPT_READER_NOW - PROMPT_READER_MIN, {
        authorId: '777',
        authorName: 'Orestis',
        content: 'γεια',
      }),
    ],
    meanwhileReads: meanwhileReads([cli]),
    lookups: [],
    chatIdOf: (placeId: string) => (placeId === 'cli:dm:owner' ? 'owner' : null),
  });
  const handle = [...(built.channelHandles ?? [])].find(([, chat]) => chat === 'owner')?.[0];
  assert.ok(handle, 'the command line chat has a place handle');
  assert.ok(headLine(built).startsWith(`#${handle}`), headLine(built));
});

const REPLY_TURN_HANDLES_MIN = 60_000;

const THINK = '<think>STEP 4. So: answer.</think>';

const SAY = `${THINK}<msg>εντάξει</msg>`;

const replyTurnHandlesIso = (at: number): string => new Date(at).toISOString();

/** A person's handle, whole. */
const HANDLE = /^@u[0-9a-z]+$/;

const REPLY_TURN_HANDLES_NIKOS = 'person:fake:4242';

const GIANNIS = 'person:tele:88';

/** The texts of the world's lines, each unique so a test finds its line in one block. */
const LINE = {
  ownerGarden: 'ΠΕΤΡΟΣ-ΣΤΟΝ-ΚΗΠΟ',
  ownerRoom: 'ΠΕΤΡΟΣ-ΣΤΟ-ΓΕΝΙΚΑ',
  ownerCli: 'ΠΟΙΟΣ-ΕΓΡΑΨΕ-ΣΤΟΝ-ΚΗΠΟ',
  giannisHarbour: 'ΓΙΑΝΝΗΣ-ΣΤΟ-ΛΙΜΑΝΙ',
  eleniGarden: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ',
  nikosOne: 'ΝΙΚΟΣ-ΑΠΟ-ΤΟ-ΕΝΑ',
  nikosTwo: 'ΝΙΚΟΣ-ΑΠΟ-ΤΟ-ΔΥΟ',
} as const;

/** The name the owner's command line account carries, and the one the owner's account on the fake interface carries. */
const OWNER_CLI_NAME = 'ΠΕΤΡΟΣ-ΚΟΝΣΟΛΑ';

const OWNER_FAKE_NAME = 'Πέτρος';

/**
 * The service world, with the owner holding an account on the command line and one on the fake interface, the owner's line in
 * the garden `c2` right after the persona's, and Γιάννης, who has an account on `tele` alone and wrote in the harbour `k1` right
 * after the persona's line there. Ελένη's line before the persona's in the garden mentions nobody; the owner's mentions Ελένη.
 */
function handleWorld(): World {
  const world = serviceWorld();
  addPerson(world.db, {
    id: OWNER_PERSON,
    accounts: [
      { id: 'cli:owner', iface: 'cli', native: 'owner', names: [OWNER_CLI_NAME] },
      { id: 'fake:u1', iface: 'fake', native: 'u1', names: [OWNER_FAKE_NAME] },
    ],
  });
  addDm(world.db, { iface: 'cli', native: 'owner', person: OWNER_PERSON, account: 'cli:owner' });
  addLine(world.db, {
    id: 'o1',
    iface: 'fake',
    place: 'fake:channel:c2',
    author: 'fake:u1',
    text: `${LINE.ownerGarden} <@111>`,
    at: replyTurnHandlesIso(TURN_NOW - 49 * REPLY_TURN_HANDLES_MIN),
  });
  addPerson(world.db, { id: GIANNIS, accounts: [{ id: 'tele:88', iface: 'tele', native: '88', names: ['Γιάννης'] }] });
  addLine(world.db, {
    id: 'y1',
    iface: 'tele',
    place: 'tele:channel:k1',
    author: 'tele:88',
    text: LINE.giannisHarbour,
    at: replyTurnHandlesIso(TURN_NOW - 39 * REPLY_TURN_HANDLES_MIN),
  });
  addPerson(world.db, {
    id: REPLY_TURN_HANDLES_NIKOS,
    accounts: [
      { id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] },
      { id: 'fake:4243', iface: 'fake', native: '4243', names: ['Νικόλαος'] },
    ],
  });
  return world;
}

/** The owner's line on the command line. */
const ownerSays = (id: string, text: string, at: number) => ({ id, text, at, authorId: 'owner', authorName: 'owner' });

/** Reply turns on the owner's command line over a fresh handle world. */
async function onCli(steps: ReadonlyArray<ReplyStep>): Promise<ReplyRun> {
  const world = handleWorld();
  try {
    return await replyRun({ world, chat: CLI_CHAT, steps });
  } finally {
    world.close();
  }
}

/** The user text of request `step` of turn `turn` of a run, '' when there is none. */
const requestOf = (run: ReplyRun, turn: number, step: number): string => {
  const requests = run.requests[turn] ?? [];
  return requests[step] ?? '';
};

/** The bodies of every `<people>` of a text: the request's own and the one a read result carries. */
const peopleBodies = (text: string): Array<string> =>
  [...text.matchAll(/<people>\n?([\s\S]*?)\n?<\/people>/g)].map((match) => match[1] ?? '');

/** The entries of every `<people>` of a text, one text each. */
const entriesOf = (text: string): Array<string> =>
  peopleBodies(text).flatMap((body) => body.split(/\n\s*\n/).filter((entry) => entry.trim() !== ''));

/** The `@u…` handle an entry opens with, null when its first line holds none. */
const entryHandle = (entry: string): string | null => /@u[0-9a-z]+/.exec(entry.split('\n')[0] ?? '')?.[0] ?? null;

/** The entry of `<people>` that holds `name`, '' when none does. */
const entryWith = (text: string, name: string): string => entriesOf(text).find((entry) => entry.includes(name)) ?? '';

/** The line of `text` that holds `marker`, '' when none does. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

describe('handles in a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('a <@id> mention in a stored line is shown as the handle of the person it names', async () => {
    // Bug: a mention stored as the platform writes it reaches the persona as a bare account number.
    const run = await onCli([
      { trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - REPLY_TURN_HANDLES_MIN), answers: [SAY] },
    ]);
    const request = requestOf(run, 0, 0);
    const line = lineWith(blockOf(request, 'meanwhile'), LINE.ownerGarden);
    const eleni = entryHandle(entryWith(request, 'Ελένη'));
    assert.match(eleni ?? '', HANDLE, 'Ελένη has an entry');
    assert.ok(line.includes(eleni ?? ''), line);
    assert.doesNotMatch(line, /<@|&lt;@|\b111\b/);
  });
});
