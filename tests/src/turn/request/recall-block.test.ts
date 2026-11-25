// Tests for src/turn/request/recall-block.ts: the `<recall>` that the ring of the persona's lookups (src/turn/calls.ts)
// renders, what the persona looked up in the last turns of a place. Contract:
//   Lookup = { turnId; at: number; tool; args: Record<string, unknown>; place: { id; path: Array<string> }; status;
//     extract; sourceIds: Array<string>; anchorMessageIds: Array<string> }
//   recallBlockOf(lookups: Array<Lookup>, window: { retired: Set<string> }, labels: Labels, timezone: string): string
// `recallBlockOf` leaves out an entry whose sources are all retired. The ring itself is tested in
// tests/src/turn/calls.test.ts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createLookupRing } from '../../../../src/turn/calls.ts';
import type { Lookup } from '../../../../src/turn/calls.ts';
import { numberedLookups, recallBlockOf } from '../../../../src/turn/request/recall-block.ts';
import { fill } from '../../../../src/format.ts';
import { shippedLabels } from '../../../fixtures/shipped-labels.ts';
import { userText as contentText } from '../../../../src/behavior/prompt.ts';
import { stretchText } from '../../../../src/behavior/recall.ts';
import { frameOf, type FrameParty } from '../../../../src/turn/request/frame.ts';
import { buildRequest, type Built } from '../../../fixtures/built-request.ts';
import { frameInput, ROOM_CHAIN } from '../../../fixtures/frame-input.ts';
import { type FakePlace, line, meanwhileReads } from '../../../fixtures/meanwhile-reads.ts';
import { mediaNamesOf } from '../../../fixtures/media-namer.ts';
import { addDm, addLine, addPerson, type World } from '../../../fixtures/memory-db/mind-world.ts';
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
  replyTurns,
  serviceWorld,
  TURN_NOW,
} from '../../../fixtures/service-turn.ts';
import { call, toolAnswer } from '../../../fixtures/tool-answers.ts';
import { useIface } from '../../../fixtures/turn-world.ts';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const MIN = 60_000;
/** Values for `context.recall`. */
const SETTINGS = { maxItems: 6, extractChars: 1200 };
const ROOM = { id: 'place:room', path: ['fake', 'Αγορά', 'γενικά'] };

function lookup(over: Partial<Lookup> = {}): Lookup {
  return {
    turnId: 'turn:7',
    at: NOW - 10 * MIN,
    tool: 'memory.search',
    args: { query: 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ', place: 'λέσχη' },
    place: ROOM,
    status: 'ok',
    extract: 'ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ',
    sourceIds: ['src:fake:m50:1:seen'],
    anchorMessageIds: ['m10'],
    ...over,
  };
}

const lines = (...ids: Array<string>) => ids.map((id) => ({ id, replyTo: null }));

test('a lookup of one turn renders in <recall> of the next with where from, what, the query, the status and the extract', () => {
  // Bug: the next turn sees the call mark and no result, so the persona searches again or invents the answer.
  const ring = createLookupRing([]);
  ring.note(lookup(), SETTINGS);
  const kept = ring.forPlace('place:room', lines('m10', 'm11'), NOW);
  const text = recallBlockOf(kept, { retired: new Set() }, shippedLabels, 'UTC');
  for (const value of ['γενικά', 'memory.search', 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ', 'ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ'])
    assert.ok(text.includes(value), value);
  const failed = recallBlockOf([lookup({ status: 'failed' })], { retired: new Set() }, shippedLabels, 'UTC');
  assert.notEqual(text, failed, 'the status is rendered');
});

test('a lookup whose sources are all retired is absent from <recall>', () => {
  // Bug: a deleted message keeps being quoted back to the persona as if it still stood.
  const text = recallBlockOf([lookup()], { retired: new Set(['src:fake:m50:1:seen']) }, shippedLabels, 'UTC');
  assert.ok(!text.includes('ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ'));
});

test('a lookup with one of two sources retired stays in <recall>', () => {
  // Bug: one retired source throws away a result the other source still supports.
  const both = lookup({ sourceIds: ['src:fake:m50:1:seen', 'src:fake:m51:1:seen'] });
  const text = recallBlockOf([both], { retired: new Set(['src:fake:m50:1:seen']) }, shippedLabels, 'UTC');
  assert.ok(text.includes('ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ'));
});

/** A label of `tools.tools.conversation` in the shipped labels, '' when absent. */
const conversationLabel = (key: string): string => {
  let node: unknown = shippedLabels;
  for (const step of ['tools', 'tools', 'conversation', key])
    node = node !== null && typeof node === 'object' ? Reflect.get(node, step) : undefined;
  return typeof node === 'string' ? node : '';
};
const HANDLES_LINE = conversationLabel('handles');
const TRANSCRIPT = shippedLabels.transcript;
/** A read of an earlier turn: two lines numbered #23 and #24 in that turn, and the line that says how to read on. */
const READ = [
  HANDLES_LINE,
  '#23 [11:09] @uab: ΓΡΑΜΜΗ-ΕΝΑ',
  '#24 [11:10] @ucd: ΓΡΑΜΜΗ-ΔΥΟ',
  fill(conversationLabel('earlier'), { n: '23' }),
].join('\n');
const LINES = [
  { n: 23, id: 'm1', placeId: 'place:garden', message: { sourceId: 'src:fake:m1:1:seen' } },
  { n: 24, id: 'm2', placeId: 'place:garden', message: { sourceId: 'src:fake:m2:1:seen' } },
];

test('an extract the journal restored shows no number and no line that offers one', () => {
  // Bug: a restart refills the ring from the journal without the lines the numbers named, and the extract keeps the
  // earlier turn's numbers, which name nothing in this turn or another line of its chat.
  const { lookups, refs } = numberedLookups([lookup({ extract: READ })], {
    from: 40,
    live: () => true,
    labels: shippedLabels,
  });
  assert.deepEqual(refs, []);
  assert.equal(lookups[0]?.extract, '[11:09] @uab: ΓΡΑΜΜΗ-ΕΝΑ\n[11:10] @ucd: ΓΡΑΜΜΗ-ΔΥΟ');
});

test('a gone first line takes its way to read earlier with it and the next line keeps a fresh number', () => {
  // Bug: the line that says how to read on keeps a number whose line is gone, so the call it offers is refused.
  const { lookups, refs } = numberedLookups([lookup({ extract: READ, lines: LINES })], {
    from: 40,
    live: (sourceId) => sourceId !== 'src:fake:m1:1:seen',
    labels: shippedLabels,
  });
  assert.deepEqual(
    refs.map((ref) => [ref.n, ref.id]),
    [[40, 'm2']]
  );
  assert.equal(
    lookups[0]?.extract,
    [HANDLES_LINE, '[11:09] @uab: ΓΡΑΜΜΗ-ΕΝΑ', '#40 [11:10] @ucd: ΓΡΑΜΜΗ-ΔΥΟ'].join('\n')
  );
});

test('a #5 someone wrote in a quoted line stays while the line takes a fresh number', () => {
  // Bug: the extract was renumbered by a pattern over its whole text, so a number in someone's words was cut or
  // turned into another, and the line did not say what was written.
  const extract = ['#23 [11:09] @uab: το #5 είναι καλό', '#24 [11:10] @ucd: δες #23 και #5'].join('\n');
  const { lookups } = numberedLookups([lookup({ extract, lines: LINES })], {
    from: 40,
    live: (sourceId) => sourceId !== 'src:fake:m2:1:seen',
    labels: shippedLabels,
  });
  assert.equal(lookups[0]?.extract, '#40 [11:09] @uab: το #5 είναι καλό\n[11:10] @ucd: δες #23 και #5');
});

test('a reply in <recall> whose parent line is gone reads as a reply to an older line, with no number and no empty slot', () => {
  // Bug: the reply marker keeps its number for a parent no call of this turn can resolve, or loses only the number and
  // leaves a marker with an empty slot, so the persona reads a reply to a line the request does not show.
  const reply = fill(TRANSCRIPT.replyTo ?? '', { author: '@uab', index: '23', quote: 'ΓΡΑΜΜΗ-ΕΝΑ' });
  const extract = ['#23 [11:09] @uab: ΓΡΑΜΜΗ-ΕΝΑ', `#24 [11:10] @ucd: ΓΡΑΜΜΗ-ΔΥΟ ${reply} [image]`].join('\n');
  const { lookups } = numberedLookups([lookup({ extract, lines: LINES })], {
    from: 40,
    live: (sourceId) => sourceId !== 'src:fake:m1:1:seen',
    labels: shippedLabels,
  });
  const line = (lookups[0]?.extract ?? '').split('\n').find((one) => one.includes('ΓΡΑΜΜΗ-ΔΥΟ')) ?? '';
  assert.ok(line.startsWith('#40 [11:10] @ucd: ΓΡΑΜΜΗ-ΔΥΟ '), line);
  assert.ok(line.includes(TRANSCRIPT.replyToOld ?? '\u0000'), line);
  assert.ok(line.endsWith(' [image]'), line);
  assert.doesNotMatch(line.slice('#40'.length), /#\d/u);
  assert.doesNotMatch(line, /\s{2}|\(\s|\s\)/u);
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

const nameOf = (id: string): string | null => (id === '111' ? 'Ελένη' : null);

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
      nameOf,
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

test('a lookup whose source row names a deleted line is absent from <recall>, whatever its source id spells', () => {
  // Bug: the line was found by cutting the source id's text, so a source stored under an opaque id was never checked
  // and a deleted line kept its lookup in <recall>.
  const lookups = [{ ...LOOKUP, sourceIds: ['source:opaque-50'] }];
  const built = request({ lookups, isSourceRetired: (id: string) => id === 'source:opaque-50' });
  assert.doesNotMatch(block(built, 'recall'), /ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ/);
});

test('a lookup whose source row names a live line stays in <recall>, whatever its source id spells', () => {
  // Bug: a source id that is not spelled `src:` counts as retired and a valid result leaves <recall>.
  const lookups = [{ ...LOOKUP, sourceIds: ['source:opaque-50'] }];
  const built = request({ lookups, isSourceRetired: (id: string) => id !== 'source:opaque-50' });
  assert.match(block(built, 'recall'), /ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ/);
});

// A place reads in words and every chat has a handle. A place a request names carries
// its interface's id, its chain innermost first and the names its interface declared in its hello.
const NAMES = { interface: 'Agora Net', nouns: { server: 'realm', channel: 'room' }, dm: 'direct talk' };

/** The stored view of a place, as `placePathOf` gives it. */
const viewOf = (iface: string, chain: PlaceChain, dm = false, partnerKey: string | null = null) => ({
  path: [iface, ...chain.map((one) => one.name ?? '').reverse()],
  iface,
  chain,
  names: NAMES,
  dm,
  partnerKey,
});

type PlaceChain = Array<{ id: string; kind: string; name: string | null }>;

const ROOM_PLACE: PlaceChain = [
  { id: 'place:room', kind: 'channel', name: 'γενικά' },
  { id: 'place:root', kind: 'server', name: 'Αγορά' },
];

const CHATS: Record<string, string> = { 'place:club': 'c-club', 'place:room': 'c-room' };

test('<recall> names the place a lookup was made in in words, with no >', () => {
  // Bug: the `from` of a lookup was the path of names joined with `>`.
  const built = request({
    chatIdOf: (placeId: string) => CHATS[placeId] ?? null,
    placePathOf: (placeId: string) => (placeId === 'place:room' ? viewOf('fake', ROOM_PLACE) : null),
  });
  const recall = block(built, 'recall');
  assert.ok(recall.includes('γενικά'), recall);
  assert.doesNotMatch(recall, />/);
});

// The rule of 2026-11-17: one `<media>` block per request, one line per thing. A stretch the persona looked up stands in
// `<recall>` with bare stable names, and their lines join the root `<media>`; a tool result read on its own keeps its
// legend. The emoji and its names are the test's.
const LANTERN = {
  name: 'e5',
  kind: 'emoji' as const,
  iface: 'fake',
  nativeId: '505',
  platformName: 'φαναράκι',
  animated: false,
};

const LANTERN_NAMES = mediaNamesOf([LANTERN]);

/** A tool result's stretch as memory.search gives it: its own legend, then the line that names `:e5:`. */
const LANTERN_STRETCH = stretchText(
  [{ id: 'm50', text: '[10:00] Ελένη: ΦΑΝΟΣ :e5:' }],
  [{ id: 'm50', content: 'ΦΑΝΟΣ :e5:', emojis: [{ id: '505', name: 'e5' }] }],
  shippedLabels,
  LANTERN_NAMES
);

test('a looked-up stretch that names an emoji puts its line in the root <media> and prints no <media> in <recall>', () => {
  // Bug: `<recall>` keeps the tool result's own legend, so the request holds two `<media>` blocks and the thing twice.
  const built = request({ lookups: [{ ...LOOKUP, extract: LANTERN_STRETCH }], mediaNameOf: LANTERN_NAMES });
  const user = userOf(built);
  assert.match(block(built, 'recall'), /ΦΑΝΟΣ :e5:/);
  assert.doesNotMatch(block(built, 'recall'), /media>/, 'no legend in <recall>, escaped or not');
  assert.equal(user.match(/^<media>$/gm)?.length, 1, 'one <media> block');
  assert.match(block(built, 'media'), /:e5: φαναράκι/);
});

const REPLY_TURN_HANDLES_MIN = 60_000;

const THINK = '<think>STEP 4. So: answer.</think>';

const SAY = `${THINK}<msg>εντάξει</msg>`;

const iso = (at: number): string => new Date(at).toISOString();

const NIKOS = 'person:fake:4242';

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
    at: iso(TURN_NOW - 49 * REPLY_TURN_HANDLES_MIN),
  });
  addPerson(world.db, { id: GIANNIS, accounts: [{ id: 'tele:88', iface: 'tele', native: '88', names: ['Γιάννης'] }] });
  addLine(world.db, {
    id: 'y1',
    iface: 'tele',
    place: 'tele:channel:k1',
    author: 'tele:88',
    text: LINE.giannisHarbour,
    at: iso(TURN_NOW - 39 * REPLY_TURN_HANDLES_MIN),
  });
  addPerson(world.db, {
    id: NIKOS,
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

/** The handles of every entry of every `<people>` of a text. */
const entryHandles = (text: string): Array<string> =>
  entriesOf(text).flatMap((entry) => {
    const handle = entryHandle(entry);
    return handle === null ? [] : [handle];
  });

/** The line of `text` that holds `marker`, '' when none does. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

/** The part of a line before `marker`: its number, time and author. */
const headOf = (text: string, marker: string): string => {
  const line = lineWith(text, marker);
  return line.slice(0, Math.max(0, line.indexOf(marker)));
};

/** The `@u…` handles that stand on the line of `marker` before it: the line's author. */
const authorOf = (text: string, marker: string): Array<string> => headOf(text, marker).match(/@u[0-9a-z]+/g) ?? [];

/**
 * The `#c…` handle of the place entry of `<places>` whose heading holds `name` in quotes. A
 * place reads as the interface's noun and the quoted name, `#c…: channel "name", ...`.
 */
function placeHandle(request: string, name: string): string {
  const places = /<places>\n?([\s\S]*?)\n?<\/places>/.exec(request)?.[1] ?? '';
  const entry = places.split(/\n\s*\n/).find((one) => (one.split('\n')[0] ?? '').includes(`"${name}"`)) ?? '';
  return /#c[0-9a-z]+/.exec(entry)?.[0] ?? '';
}

/** A turn on the command line in which the persona reads the garden by its name, finding the owner's line, then answers. */
const READ_GARDEN: ReplyStep = {
  trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - 3 * REPLY_TURN_HANDLES_MIN),
  answers: [toolAnswer(THINK, [call('conversation.read', { place: 'κήπος', last: 10 })]), SAY],
};

/** The owner's next line, whose turn shows the read in `<recall>`. */
const THANKS: ReplyStep = { trigger: ownerSays('m2', 'ευχαριστώ', TURN_NOW - REPLY_TURN_HANDLES_MIN), answers: [SAY] };

describe('handles in a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('every author of a line in <recall> is the handle of an entry of <people>', async () => {
    // Bug: <recall> repeats the read as it was rendered, with display names, so the next turn ties its lines to nobody.
    const run = await onCli([READ_GARDEN, THANKS]);
    const request = requestOf(run, 1, 0);
    const recall = blockOf(request, 'recall');
    assert.ok(recall.includes(LINE.ownerGarden), 'the read stands in <recall>');
    const handles = entryHandles(request);
    for (const marker of [LINE.ownerGarden, LINE.eleniGarden]) {
      const author = authorOf(recall, marker);
      assert.equal(author.length, 1, `the line ${marker} names one handle`);
      assert.ok(handles.includes(author[0] ?? ''), `the author of ${marker} opens an entry`);
    }
  });

  test('a place the persona searched reads as its handle and name in <recall> and in the call mark of the persona', async () => {
    // Bug: the place argument of a lookup is kept as its resolved place id, and the next turn shows the persona the raw id.
    const run = await onCli([READ_GARDEN, THANKS]);
    const request = requestOf(run, 1, 0);
    const garden = placeHandle(request, 'κήπος');
    assert.match(garden, /^#c[0-9a-z]+$/, 'the garden has an entry with a handle');
    const recalled = lineWith(blockOf(request, 'recall'), 'conversation.read');
    assert.ok(recalled.includes(garden) && recalled.includes('κήπος'), recalled);
    const mark = lineWith(blockOf(request, 'chat'), 'conversation.read');
    assert.ok(mark.includes(garden), mark);
  });
});

const REPLY_TURN_MEMORY_MIN = 60_000;

const REPLY_TURN_MEMORY_SAY = `${THINK}<msg>γεια</msg>`;

// The `#N` numbers of `<recall>` (plan 2026-11-10 tools-and-reads, item 22). An extract repeats a read of an earlier
// turn, and a number is valid only in the request that issued it, so every number the extract shows must name, in this
// turn's calls, the line it named when it was read, and a line memory no longer holds is shown with no number. The
// turn reads the garden `c2` of the service world, Ελένη's line and the persona's after it; a call `around` a number with no line
// before or after it reads back exactly the line the number names.

const GARDEN = { eleni: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ', persona: 'ΔΙΚΗ-ΤΗΣ-ΚΗΠΟΣ' } as const;

/** The persona's answer that reads the garden by its name. */
const REPLY_TURN_MEMORY_READ_GARDEN = toolAnswer(THINK, [call('conversation.read', { place: 'κήπος', last: 10 })]);

describe('memory in a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('a line of <recall> whose stored line is gone is shown with no number', async () => {
    // Bug: the extract prints the number the earlier read gave a line memory no longer holds, and no call of this turn
    // can resolve it, so the number points at nothing.
    const world = serviceWorld();
    try {
      const retireEleni = (): string => {
        world.db.prepare('UPDATE sources SET retired_at = ? WHERE id = ?').run(new Date(TURN_NOW).toISOString(), 'g0');
        return REPLY_TURN_MEMORY_SAY;
      };
      const [, second = []] = await replyTurns({
        world,
        steps: [
          {
            trigger: { id: 'r2', text: 'τι γράφουν στον κήπο;', at: TURN_NOW - 3 * REPLY_TURN_MEMORY_MIN },
            answers: [REPLY_TURN_MEMORY_READ_GARDEN, retireEleni],
          },
          {
            trigger: { id: 'r3', text: 'καλά', at: TURN_NOW - REPLY_TURN_MEMORY_MIN },
            answers: [REPLY_TURN_MEMORY_SAY],
          },
        ],
      });
      const recall = blockOf(second[0] ?? '', 'recall');
      assert.ok(recall.includes(GARDEN.persona), 'the lookup stands, the line of the persona is live');
      const line = lineWith(recall, GARDEN.eleni);
      assert.ok(line !== '', 'the gone line stands in the extract');
      assert.doesNotMatch(line, /(?<![\p{L}\p{N}_])#\d+\b/u);
    } finally {
      world.close();
    }
  });
});
