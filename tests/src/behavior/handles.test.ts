// Tests for src/behavior/handles.ts: handles derived from the user id (stable, unique within a
// request, a profiled member never moved by one in view) and `@handle` -> `<@id>` in the persona's output. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_HANDLE_PREFIX,
  HANDLE_DIGITS,
  HANDLE_PREFIX,
  assignHandles,
  handleBook,
  handleOf,
  resolveHandles,
  widenHandles,
  memberNameMap,
  untaggedNames,
  withUserHandles,
} from '../../../src/behavior/handles.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { labels as fixtureLabels } from '../../fixtures/labels.ts';
import { buildRequest } from '../../fixtures/built-request.ts';
import type { Built } from '../../fixtures/built-request.ts';
import {
  frameOfInput,
  MIN as PROMPT_READER_MIN,
  NOW as PROMPT_READER_NOW,
  baseInput,
  fakeConfig as promptReaderFakeConfig,
  fakePrompts,
  makeMessage,
} from '../../fixtures/prompt-rig.ts';
import { frameOf } from '../../../src/turn/request/frame.ts';
import type { FrameParty } from '../../../src/turn/request/frame.ts';
import type { Lookup } from '../../../src/turn/calls.ts';
import { ROOM_CHAIN, frameInput } from '../../fixtures/frame-input.ts';
import { line as promptReaderLine, meanwhileReads } from '../../fixtures/meanwhile-reads.ts';
import type { FakePlace } from '../../fixtures/meanwhile-reads.ts';
import { mindOfEntries, personEntry, placeEntry } from '../../fixtures/mind-entries.ts';
import { shippedLabels } from '../../fixtures/shipped-labels.ts';
import { addDm, addLine, addPerson } from '../../fixtures/memory-db/mind-world.ts';
import type { World } from '../../fixtures/memory-db/mind-world.ts';
import { OWNER_PERSON } from '../../fixtures/owner-accounts.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import { useIface } from '../../fixtures/turn-world.ts';
import { CLI_CHAT, TURN_NOW, blockOf, replyRun, serviceWorld } from '../../fixtures/service-turn.ts';
import type { ReplyRun, ReplyStep } from '../../fixtures/service-turn.ts';

// Two ids whose four-digit handles collide (found by search; see the derivation in handles.js).
const OLDER = '400000000000807738';
const NEWER = '400000000005693761';

test('handleOf: the prefix and four base-36 digits, the same for the same id every time', () => {
  const handle = handleOf('123456789012345678');
  assert.match(handle, new RegExp(`^${HANDLE_PREFIX}[0-9a-z]{${HANDLE_DIGITS}}$`));
  assert.equal(handleOf('123456789012345678'), handle);
  assert.notEqual(handleOf('123456789012345679'), handle);
  assert.match(handleOf('123456789012345678', 6), /^u[0-9a-z]{6}$/);
});

test('assignHandles: one handle per id, unique, whatever the order the ids come in', () => {
  const ids = Array.from({ length: 300 }, (_, i) => String(300000000000000000n + BigInt(i) * 104729n));
  const forward = assignHandles({ profiled: ids });
  const backward = assignHandles({ profiled: [...ids].reverse() });
  assert.equal(forward.size, ids.length);
  assert.equal(new Set(forward.values()).size, ids.length, 'no handle given twice');
  assert.deepEqual(
    [...ids].map((id) => backward.get(id)),
    [...ids].map((id) => forward.get(id))
  );
});

test('assignHandles: of two ids sharing a handle the older keeps it, the newer takes one more digit', () => {
  assert.equal(handleOf(OLDER), handleOf(NEWER), 'the fixture ids collide');
  const handles = assignHandles({ profiled: [NEWER, OLDER] });
  assert.equal(handles.get(OLDER), handleOf(OLDER));
  assert.equal(handles.get(NEWER), handleOf(NEWER, HANDLE_DIGITS + 1));
});

test("assignHandles: a member only in view never moves a profiled member's handle", () => {
  const handles = assignHandles({ profiled: [NEWER], inView: [OLDER, NEWER, '1'] });
  assert.equal(handles.get(NEWER), handleOf(NEWER), 'the profiled member keeps the short form');
  assert.equal(handles.get(OLDER), handleOf(OLDER, HANDLE_DIGITS + 1), 'the passer-by takes one more digit');
  assert.equal(handles.get('1'), handleOf('1'));
  assert.equal(handles.size, 3, 'a profiled id in view is placed once');
});

test('assignHandles: blank and missing ids are skipped', () => {
  assert.deepEqual([...assignHandles({ profiled: wrongly(['', null, undefined]), inView: [] }).keys()], []);
  assert.equal(assignHandles().size, 0);
});

test('resolveHandles: an exact @handle becomes a mention; names and look-alikes stay text', () => {
  const ids = new Map([
    ['uaaaa', '111111111111111111'],
    ['ubbbb', '222222222222222222'],
  ]);
  const result = resolveHandles('@uaaaa γεια, @ubbbb! @uaaaa @Ana mail@uaaaa @uaaaab @uaaaaά', ids);
  assert.equal(
    result.text,
    '<@111111111111111111> γεια, <@222222222222222222>! <@111111111111111111> @Ana mail@uaaaa @uaaaab @uaaaaά'
  );
  assert.deepEqual(result.accountIds, ['111111111111111111', '222222222222222222']);
  assert.equal(result.unknown, 1, 'only @uaaaab is a handle nobody has');
});

test('resolveHandles: a handle inside a URL is part of the address; @everyone is never a handle', () => {
  const ids = new Map([['uaaaa', '111111111111111111']]);
  const result = resolveHandles('https://example.com/@uaaaa @everyone @here @uaaaa', ids);
  assert.equal(result.text, 'https://example.com/@uaaaa @everyone @here <@111111111111111111>');
  assert.deepEqual(result.accountIds, ['111111111111111111']);
  assert.equal(result.unknown, 0);
});

test('resolveHandles: no map resolves nothing', () => {
  assert.deepEqual(resolveHandles('@uaaaa', wrongly(null)), { text: '@uaaaa', accountIds: [], unknown: 1 });
});

test('widenHandles: a handle shown in an earlier request resolves for a known id; a shared short handle stays out', () => {
  // Bug: the persona's `@handle` of a member this request did not show was posted as plain text.
  const widened = widenHandles(null, ['1', OLDER, NEWER]);
  assert.equal(widened.get(handleOf('1')), '1');
  assert.equal(widened.has(handleOf(OLDER)), false, 'two known ids share the short handle: neither is guessed');
  assert.equal(widened.get(handleOf(OLDER, HANDLE_DIGITS + 1)), OLDER);
  assert.equal(widened.get(handleOf(NEWER, HANDLE_DIGITS + 1)), NEWER);
  assert.equal(resolveHandles(`@${handleOf('1')} γεια`, widened).text, '<@1> γεια');
});

test("widenHandles: the request's own handles win; channel ids take the channel prefix", () => {
  const shown = new Map([[handleOf(OLDER), OLDER]]);
  assert.equal(widenHandles(shown, [NEWER]).get(handleOf(OLDER)), OLDER);
  const channels = widenHandles(null, ['5'], CHANNEL_HANDLE_PREFIX);
  assert.equal(channels.get(handleOf('5', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX)), '5');
  assert.equal(channels.has(handleOf('5')), false, 'no member handle for a channel');
});

test('handleBook: a fixed key keeps the handle it was given, and a key placed beside it never takes that handle', () => {
  // Bug: a person of <memory> takes the short form a chat author already shows, and one handle names two people.
  const book = handleBook(new Map([[NEWER, handleOf(NEWER)]]), { profiled: [OLDER] });
  assert.equal(book.handleOf(NEWER), handleOf(NEWER));
  assert.equal(book.handleOf(OLDER), handleOf(OLDER, HANDLE_DIGITS + 1));
});

test('handleBook: a key met later takes the shortest form no other key holds, and the same one when asked again', () => {
  // Bug: a mention in a stored text met after the entries are placed takes a handle an entry holds, or a new one at
  // each ask, so the text and the entry name two people.
  const book = handleBook(new Map(), { profiled: [OLDER] });
  const later = book.handleOf(NEWER);
  assert.equal(later, handleOf(NEWER, HANDLE_DIGITS + 1));
  assert.equal(book.handleOf(NEWER), later);
  assert.deepEqual(
    [...book.entries()],
    [
      [OLDER, handleOf(OLDER)],
      [NEWER, later],
    ]
  );
});

// ---- the tag that names a member without the handle ----

const YOB = '100000000000000001';
const NORTY = '100000000000000002';
const NORA = '100000000000000003';
const names = new Map([
  [YOB, ['Yob', 'Βοβ']],
  [NORTY, ['🌸Norty🌸', 'Norti']],
  [NORA, ['Nor']],
]);
const handles = new Map([
  [YOB, 'uq03j'],
  [NORTY, 'ueyi7'],
  [NORA, 'u0nor'],
]);
const found = (text: string, mentionedIds: Array<string> = []) =>
  untaggedNames(text, { names, handles, mentionedIds }).map((hit) => `${hit.name}>${hit.handle}`);

test('untaggedNames: a name or an alias after @ is found, in any case, whole names only', () => {
  assert.deepEqual(found('hi @yob and @NORTI!'), ['yob>uq03j', 'NORTI>ueyi7']);
  assert.deepEqual(found('hi @Βοβ, ok'), ['Βοβ>uq03j']);
  assert.deepEqual(found('@Yobanov and mail@Yob'), [], 'a longer word or a word right before the @ is not a tag');
});

test('untaggedNames: emoji names, the longest name first, each member once', () => {
  assert.deepEqual(found('@🌸Norty🌸 hello'), ['🌸Norty🌸>ueyi7']);
  assert.deepEqual(found('@Nor @Norti @Nor'), ['Nor>u0nor', 'Norti>ueyi7'], '@Norti is Norti, not Nor + ti');
});

test('untaggedNames: a handle, a real mention, a URL or a member without a handle is not flagged', () => {
  assert.deepEqual(found('@uq03j @ueyi7'), []);
  assert.deepEqual(found('@Yob hi @Norti', [YOB]), ['Norti>ueyi7'], 'the mentioned one is not flagged');
  assert.deepEqual(found('see https://x.test/@Yob/page'), []);
  assert.deepEqual(untaggedNames('@Yob', { names, handles: new Map(), mentionedIds: [] }), []);
  assert.deepEqual(untaggedNames('no at sign', { names, handles }), []);
});

test('untaggedNames: a name shared with a mentioned member counts as theirs', () => {
  const shared = new Map([...names, ['200', ['Yob']]]);
  const both = new Map([...handles, ['200', 'u0200']]);
  assert.deepEqual(untaggedNames('@Yob', { names: shared, handles: both, mentionedIds: ['200'] }), []);
});

test('withUserHandles: a mentioned member reads as their handle, the rest stays as written', () => {
  const members = { names, handles };
  assert.equal(withUserHandles('hey @Yob and @Norti, @Yobanov', [YOB], members), 'hey @uq03j and @Norti, @Yobanov');
  assert.equal(
    withUserHandles('@🌸Norty🌸 look https://x.test/@Yob', [NORTY], members),
    '@ueyi7 look https://x.test/@Yob'
  );
  assert.equal(
    withUserHandles('hey @Yob', [YOB], { names, handles: new Map() }),
    'hey @Yob',
    'no handle: the name stays'
  );
  assert.equal(withUserHandles('hey @Yob', [], members), 'hey @Yob');
});

// A bot is a person to the persona, so a bot's name is read like a member's.
test('memberNameMap: directory names and aliases, authors and mentioned members, bots too, never self', () => {
  const map = memberNameMap(
    [{ id: '1', names: ['Ana'], aliases: ['Anita'] }],
    [
      { authorId: '1', authorName: 'Ana' },
      { authorId: '2', authorName: 'Bo', mentionedUsers: [{ id: '3', name: 'Cy' }] },
      { authorId: '9', authorName: 'Me', self: true },
      { authorId: '8', authorName: 'Bot', bot: true },
    ]
  );
  assert.deepEqual(
    [...map],
    [
      ['1', ['Ana', 'Anita']],
      ['2', ['Bo']],
      ['3', ['Cy']],
      ['8', ['Bot']],
    ]
  );
});

const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);

const MIN = 60_000;

const SELF_ID = '900000000000000001';

// Terse test wording for the keys under test (the shipped wording is the dev agent's).
const labels = {
  ...fixtureLabels,
  // One handle per person: a line's author is the handle alone (authors.line).
  authors: { line: '{handle}', lineAccount: '{handle} ({iface} {id})', unknown: 'someone' },
  directory: { lead: 'DIRECTORY', line: '{handle} {names}', lineAliases: '{handle} {names} aka {aliases}' },
};

// 23 members, as a mid-sized server keeps them: one to three names, up to three aliases, some closed.
const NAMES = [
  ['Ἀλκμήνη'],
  ['Zoé', 'Zoé ✿'],
  ['Léo Martin'],
  ['Ταξιάρχης'],
  ['Anaïs', 'anaïs_42'],
  ['Bérénice'],
  ['Δημήτρης'],
  ['Élodie', 'Élo'],
  ['François'],
  ['Ἑλένη', 'Helena'],
  ['Inès'],
  ['Jérôme', 'J.'],
  ['Κωνσταντίνος'],
  ['Loïc'],
  ['Maëlle', 'Maëlle (away)', 'mae'],
  ['Νίκος'],
  ['Océane'],
  ['Pénélope'],
  ['Ρένα'],
  ['Sébastien'],
  ['Σοφία'],
  ['Thaïs'],
  ['Ulysse'],
];

const ALIASES = [
  ['Ἀλκ'],
  [],
  ['Léo', 'Martinou'],
  ['Ταξ'],
  [],
  ['Béré', 'Nice'],
  [],
  ['Lodie'],
  ['Franz'],
  ['Λένα'],
  [],
  ['Jéjé'],
  ['Κώστας', 'Ντίνος'],
  [],
  ['Maë'],
  [],
  ['Océ'],
  ['Pénny'],
  [],
  ['Séb', 'Bastien'],
  ['Σόφη'],
  [],
  ['Ulyx'],
];

const PROFILES = NAMES.map((names, i) => ({
  id: String(700000000000000000n + BigInt(i) * 7_340_033n),
  names,
  aliases: [
    ...ALIASES[i].map((name) => ({ name, weight: 3 })),
    ...(i % 5 === 0 ? [{ name: 'Old nick', weight: 1, validTo: '2026-01-01' }] : []),
  ],
  character: 'a note the directory never shows',
  interests: [{ topic: 'a game the directory never shows', weight: 4 }],
}));

const SELF_PROFILE = { id: SELF_ID, names: ['Nept'], aliases: [] };

function fakeConfig(features = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      tempo: { liveMessages10min: 4, deadSilenceMinutes: 45 },
    },
    features: { vision: true, ...features },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
    memory: { recentHours: 72 },
  };
}

function line(
  id: string,
  minutesAgo: number,
  author: { id: string; name?: string; names?: Array<string> },
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    ts: NOW - minutesAgo * MIN,
    authorId: author.id,
    authorName: author.names?.[0] ?? author.name,
    self: false,
    content: `line ${id}`,
    attachments: [],
    stickers: [],
    replyToId: null,
    ...overrides,
  };
}

const STRANGER = { id: '650000000000000123', name: 'Passer-by' };

const BOT = { id: '650000000000000999', name: 'HelperBot' };

function input(overrides: Record<string, unknown> = {}) {
  const history = (overrides.history ?? [
    line('1', 3, PROFILES[0]),
    line('2', 2, STRANGER),
    line('3', 1, PROFILES[1]),
  ]) as Array<ReturnType<typeof line>>;
  const base = {
    config: fakeConfig(),
    prompts: {
      main: 'SYSTEM',
      persona: 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      'turn/reply': 'REPLY to {{author}}',
      interject: 'INTERJECT',
      labels,
    },
    calibrator: { ratio: 1, apply: (n: number) => n },
    mode: 'reply',
    now: NOW,
    selfName: 'Nept',
    selfId: SELF_ID,
    history,
    neighbors: [],
    trigger: history.at(-1),
    triggerKind: 'mention',
    placeMemory: {},
    interlocutor: null,
    otherProfiles: [],
    candidateProfiles: [...PROFILES, SELF_PROFILE],
    ...overrides,
  };
  // Every request is built on its turn frame (slice 7).
  return { ...base, frame: frameOfInput(base) };
}

// A bot is a person to the persona, so a bot author carries a handle like a member.
test('buildRequest: every author in view carries a handle on their lines, a bot too; the persona does not', () => {
  const history = [
    line('1', 4, PROFILES[0]),
    line('2', 3, STRANGER),
    line('3', 2, BOT, { bot: true }),
    line('4', 1, { id: SELF_ID, name: 'Nept' }, { self: true }),
  ];
  const request = buildRequest(input({ history, trigger: history[1] }));
  const secondMessage = request.messages[1];
  const text = userText(secondMessage.content);
  const profiled = assignHandles({ profiled: PROFILES.map((profile) => profile.id) });
  assert.ok(text.includes(`] @${profiled.get(PROFILES[0].id)}: line 1`), text);
  assert.ok(text.includes(`] @${handleOf(STRANGER.id)}: line 2`), text);
  assert.ok(text.includes(`] @${handleOf(BOT.id)}: line 3`), text);
  assert.ok(text.includes('Nept (you): line 4'), text);
  assert.equal(request.handles!.get(handleOf(STRANGER.id)), STRANGER.id, 'a member without a profile is taggable');
  assert.equal(request.handles!.get(profiled.get(PROFILES[0].id)!), PROFILES[0].id);
  assert.equal([...request.handles!.values()].includes(BOT.id), true, 'a bot gets a handle');
  assert.equal([...request.handles!.values()].includes(SELF_ID), false, 'the persona gets no handle');
  // Slice 7: no directory up front (the lead's decision 3), so the handles are those of the people in the request: the
  // profiled author, the stranger and the bot, not every profiled member.
  assert.equal(request.handles!.size, 3);
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

/** The club with a line of the persona among three of Eleni's. */
const CLUB_LINES: FakePlace = {
  id: 'place:club',
  path: ['fake', 'Αγορά', 'λέσχη'],
  dm: false,
  lines: [
    promptReaderLine('place:club', 'c1', PROMPT_READER_NOW - 40 * PROMPT_READER_MIN, '111', 'πρώτη'),
    promptReaderLine('place:club', 'c2', PROMPT_READER_NOW - 39 * PROMPT_READER_MIN, '111', 'δεύτερη'),
    promptReaderLine('place:club', 'c3', PROMPT_READER_NOW - 38 * PROMPT_READER_MIN, null, 'δική της'),
    promptReaderLine('place:club', 'c4', PROMPT_READER_NOW - 37 * PROMPT_READER_MIN, '111', 'τρίτη'),
  ],
};

const nameOf = (id: string): string | null => (id === '111' ? 'Ελένη' : null);

function request(over: Record<string, unknown> = {}): Built {
  return buildRequest(
    baseInput({
      config: promptReaderFakeConfig({ context: CONTEXT }),
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

test('a person whose account id spells no platform id takes the @handle of the platform id the account row holds', () => {
  // Bug: the handle was given to the text after the account id's first colon, so a person under an opaque account id
  // got a handle no member of the interface has and the persona's mention reached nobody.
  const zoe = personEntry('333', 'Ζωή', {
    accounts: ['account:opaque-zoe'],
    platformAccounts: [{ id: 'account:opaque-zoe', iface: 'fake', platformId: '333' }],
  });
  const built = request({ mind: mindOfEntries({ people: [ELENI, zoe] }) });
  const handled = new Set(built.handles?.values() ?? []);
  assert.ok(handled.has('333'), [...handled].join(', '));
  assert.equal(handled.has('opaque-zoe'), false);
});

test('a counterpart the reader did not raise takes the @handle of the id the interface named them by', () => {
  // Bug: the stranger's handle came from the text of the account id, which an opaque account id does not hold.
  const ana: FrameParty = { personId: null, accountId: 'account:opaque-ana', nativeId: '444', name: 'Άννα' };
  const frame = frameOf(
    frameInput({
      now: PROMPT_READER_NOW,
      timezone: TIMEZONE,
      author: ana,
      trigger: { messageId: 'm1', authorId: '444' },
    })
  );
  const built = request({ frame, mind: mindOfEntries({}) });
  const handled = new Set(built.handles?.values() ?? []);
  assert.ok(handled.has('444'), [...handled].join(', '));
});

useIface('fake');

const THINK = '<think>STEP 4. So: answer.</think>';

const SAY = `${THINK}<msg>εντάξει</msg>`;

const iso = (at: number): string => new Date(at).toISOString();

/** A person's handle, whole. */
const HANDLE = /^@u[0-9a-z]+$/;

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

/** The name the owner's command line account carries, and the one their account on the fake interface carries. */
const OWNER_CLI_NAME = 'ΠΕΤΡΟΣ-ΚΟΝΣΟΛΑ';

const OWNER_FAKE_NAME = 'Πέτρος';

/** Whether `word` stands whole in `line`. */
const holdsWord = (line: string, word: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${word}(?![\\p{L}\\p{N}_])`, 'u').test(line);

/**
 * The service world, with the owner holding an account on the command line and one on the fake interface, a line of
 * the owner in the garden `c2` right after the persona's, and Γιάννης, who has an account on `tele` alone and wrote in
 * the harbour `k1` right after the persona's line there. Ελένη's line before the persona's in the garden mentions
 * nobody, and the owner's mentions Ελένη.
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
    at: iso(TURN_NOW - 49 * MIN),
  });
  addPerson(world.db, { id: GIANNIS, accounts: [{ id: 'tele:88', iface: 'tele', native: '88', names: ['Γιάννης'] }] });
  addLine(world.db, {
    id: 'y1',
    iface: 'tele',
    place: 'tele:channel:k1',
    author: 'tele:88',
    text: LINE.giannisHarbour,
    at: iso(TURN_NOW - 39 * MIN),
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

/** Reply turns in the room `c1` of the fake interface over a fresh handle world. */
async function inRoom(steps: ReadonlyArray<ReplyStep>): Promise<ReplyRun> {
  const world = handleWorld();
  try {
    return await replyRun({ world, steps });
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

/** The entry of `<people>` that holds `name`, '' when none does. */
const entryWith = (text: string, name: string): string => entriesOf(text).find((entry) => entry.includes(name)) ?? '';

/** The line of `text` that holds `marker`, '' when none does. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

/** The part of a line before `marker`: its number, time and author. */
const headOf = (text: string, marker: string): string => {
  const line = lineWith(text, marker);
  return line.slice(0, Math.max(0, line.indexOf(marker)));
};

/** The `@u…` handles that stand on the line of `marker` before it: the line's author. */
const authorOf = (text: string, marker: string): Array<string> => headOf(text, marker).match(/@u[0-9a-z]+/g) ?? [];

/** A turn on the command line in which the persona reads the garden by its name, finding the owner's line, then answers. */
const READ_GARDEN: ReplyStep = {
  trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - 3 * MIN),
  answers: [toolAnswer(THINK, [call('conversation.read', { place: 'κήπος', last: 10 })]), SAY],
};

/** The owner's next line, whose turn shows the read in `<recall>`. */
const THANKS: ReplyStep = { trigger: ownerSays('m2', 'ευχαριστώ', TURN_NOW - MIN), answers: [SAY] };

test('a person with accounts on two interfaces has one handle on a turn of either interface', async () => {
  // Bug: the handle is cut from the platform id of an account, so the owner is one handle on the command line and
  // another in a room, and the persona takes the two for two people.
  const cli = await onCli([{ trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - MIN), answers: [SAY] }]);
  const room = await inRoom([{ trigger: { id: 'r2', text: 'καλημέρα', at: TURN_NOW - MIN }, answers: [SAY] }]);
  const onCommandLine = entryHandle(entryWith(requestOf(cli, 0, 0), OWNER_FAKE_NAME));
  const inTheRoom = entryHandle(entryWith(requestOf(room, 0, 0), OWNER_FAKE_NAME));
  assert.match(onCommandLine ?? '', HANDLE, 'the owner has an entry on the command line');
  assert.equal(inTheRoom, onCommandLine);
});

test("the owner's line on the command line and their line from another interface in <meanwhile> carry the same handle, and <people> holds the owner once with both accounts", async () => {
  // Bug: the owner's command line line names them by one handle and their line in the garden by a display name, so the
  // persona splits them into "you" and a third person with their alias.
  const run = await onCli([{ trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - MIN), answers: [SAY] }]);
  const request = requestOf(run, 0, 0);
  const entry = entryWith(request, OWNER_FAKE_NAME);
  const handle = entryHandle(entry);
  assert.match(handle ?? '', HANDLE);
  assert.deepEqual(authorOf(blockOf(request, 'chat'), LINE.ownerCli), [handle], 'their line on the command line');
  assert.deepEqual(authorOf(blockOf(request, 'meanwhile'), LINE.ownerGarden), [handle], 'their line in the garden');
  assert.equal(entryHandles(request).filter((one) => one === handle).length, 1, 'one entry of them');
  assert.ok(entry.includes(OWNER_CLI_NAME) && entry.includes(OWNER_FAKE_NAME), 'the entry holds both accounts');
});

test('an author in <chat> carries the handle their line in <meanwhile> carries, the handle of their entry', async () => {
  // Bug: a chat line names its author by the account's handle and a line elsewhere by a display name, so the persona ties the
  // two lines to an entry of <people> by comparing names.
  const run = await inRoom([
    {
      lines: [{ id: 'r2', text: LINE.ownerRoom, at: TURN_NOW - 2 * MIN, authorId: 'u1', authorName: OWNER_FAKE_NAME }],
      trigger: { id: 'r3', text: 'καλημέρα', at: TURN_NOW - MIN },
      answers: [SAY],
    },
  ]);
  const request = requestOf(run, 0, 0);
  const handle = entryHandle(entryWith(request, OWNER_FAKE_NAME));
  assert.match(handle ?? '', HANDLE);
  assert.deepEqual(authorOf(blockOf(request, 'chat'), LINE.ownerRoom), [handle]);
  assert.deepEqual(authorOf(blockOf(request, 'meanwhile'), LINE.ownerGarden), [handle]);
});

test("an author in <meanwhile> with no account on the turn's interface is the handle of an entry of <people>", async () => {
  // Bug: a line of another interface is named by a display name, or by the bare account id when the turn's interface
  // does not know the account, and no entry stands behind it.
  const run = await onCli([{ trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - MIN), answers: [SAY] }]);
  const request = requestOf(run, 0, 0);
  const author = authorOf(blockOf(request, 'meanwhile'), LINE.giannisHarbour);
  assert.equal(author.length, 1, 'their line names one handle');
  assert.ok(entryHandles(request).includes(author[0] ?? ''), 'their handle opens an entry');
});

test("lines of one person from two accounts in one place carry the person's handle and mark each account by its interface and platform id", async () => {
  // Bug: each account is a handle of its own, so one person writing from two accounts reads as two people.
  // The lead's decision of 2026-11-10: the mark is the account's interface and platform id, the pair its account line
  // in <people> carries, never a display name.
  const run = await inRoom([
    {
      lines: [
        { id: 'r2', text: LINE.nikosOne, at: TURN_NOW - 3 * MIN, authorId: '4242', authorName: 'Νίκος' },
        { id: 'r3', text: LINE.nikosTwo, at: TURN_NOW - 2 * MIN, authorId: '4243', authorName: 'Νικόλαος' },
      ],
      trigger: { id: 'r4', text: 'καλημέρα', at: TURN_NOW - MIN },
      answers: [SAY],
    },
  ]);
  const chat = blockOf(requestOf(run, 0, 0), 'chat');
  const one = authorOf(chat, LINE.nikosOne);
  assert.equal(one.length, 1);
  assert.deepEqual(authorOf(chat, LINE.nikosTwo), one, 'the same handle on both lines');
  const first = headOf(chat, LINE.nikosOne);
  const second = headOf(chat, LINE.nikosTwo);
  assert.ok(holdsWord(first, 'fake') && holdsWord(first, '4242') && !holdsWord(first, '4243'), first);
  assert.ok(holdsWord(second, 'fake') && holdsWord(second, '4243') && !holdsWord(second, '4242'), second);
  assert.ok(!first.includes('Νίκος') && !second.includes('Νικόλαος'), 'no display name marks an account');
});

test('the handles of the entries of a request are unique', async () => {
  // Guard: one handle for two people would make the persona mention and read the wrong one.
  const run = await onCli([READ_GARDEN, THANKS]);
  const handles = entryHandles(requestOf(run, 1, 0));
  assert.ok(handles.length >= 3, handles.join(' '));
  assert.equal(new Set(handles).size, handles.length, handles.join(' '));
});
