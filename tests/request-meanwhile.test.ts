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
import { meanwhileOf } from '../src/turn/request/meanwhile.ts';
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
