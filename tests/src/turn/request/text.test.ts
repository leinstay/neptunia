// Tests for src/turn/request/text.ts. `placeRefText` is the one form every request names a place in: the handle, a
// colon, the links innermost first (the interface's noun for the kind, then the name in double quotes), joined with a
// comma, then the interface by its own name. The labels are the fixture's, so the joiners are known; the nouns and the
// interface's name come from the interface's hello, never a label. `shownName` is the name of a place or of a person
// as a request shows it, and `escapeStored`, `placeToken`, `withPlaces` and `placeIdsIn` handle stored text. Made-up
// names only.
//
// Signatures these tests hold the code to:
//   export type PlaceWords = {
//     iface: string;                                   the interface's id, the name when `names` is missing
//     chain: ReadonlyArray<PlaceChainLink>;            the place first, up to the top
//     names?: InterfaceNames;                          src/protocol/serve.ts: { interface, nouns, dm }
//     partner?: string | null;                         a direct chat's partner by handle, `@` included
//     keepEmoji?: boolean;                             the setting `context.names.emoji`, read by the caller at the
//                                                      moment of use, for every link
//   };
//   export function placeRefText(labels: Labels, handle: string | null, place: PlaceWords): string;
//   export function shownName(name: string, keepEmoji?: boolean): string;   keepEmoji true: the name as stored, trimmed
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeStored,
  placeIdsIn,
  placeRefText,
  placeToken,
  shownName,
  withPlaces,
} from '../../../../src/turn/request/text.ts';
import type { PlaceWords } from '../../../../src/turn/request/text.ts';
import { labels } from '../../../fixtures/labels.ts';
import { block, hasRequiredLabels, fillPromptTemplate } from '../../../../src/behavior/prompt.ts';
import {
  addClaim,
  addLine,
  addPerson,
  addRoom,
  noteInterface,
  openWorld,
  rootId,
} from '../../../fixtures/memory-db/mind-world.ts';
import type { World } from '../../../fixtures/memory-db/mind-world.ts';
import { call, toolAnswer } from '../../../fixtures/tool-answers.ts';
import { useIface } from '../../../fixtures/turn-world.ts';
import { TURN_NOW, blockOf, replyRun } from '../../../fixtures/service-turn.ts';

const NAMES = { interface: 'Discord', nouns: { server: 'server', channel: 'channel' }, dm: 'direct chat' };

const link = (kind: string | null, name: string | null) => ({ id: `p:${kind}:${name}`, kind, name });

/** A channel in a server on the interface `Discord`. */
const inRoot = (channel: string, server: string): PlaceWords => ({
  iface: 'discord',
  chain: [link('channel', channel), link('server', server)],
  names: NAMES,
});

const directChat: PlaceWords = { iface: 'discord', chain: [link('dm', null)], names: NAMES, partner: '@uzoe1' };

test('a channel reads as its handle, the channel, its server and the interface, innermost first', () => {
  // Bug: the reference ran root first with `>` between the names, so a name read as a path and a root as a channel.
  assert.equal(
    placeRefText(labels, 'cab12', inRoot('alpha', 'Beta')),
    '#cab12: channel "alpha", server "Beta", interface "Discord"'
  );
});

test('a root reads without a channel above or below it', () => {
  assert.equal(
    placeRefText(labels, 'cde34', { iface: 'discord', chain: [link('server', 'Beta')], names: NAMES }),
    '#cde34: server "Beta", interface "Discord"'
  );
});

test('a channel named exactly like its noun still reads as a name in quotes', () => {
  // Bug: `channel channel` read as one word, and the model took the name for the noun.
  const text = placeRefText(labels, 'c1', inRoot('channel', 'Beta'));
  assert.ok(text.includes('channel "channel"'), text);
});

test("a root named exactly like the root's noun still reads as a name in quotes", () => {
  const text = placeRefText(labels, 'c1', inRoot('alpha', 'server'));
  assert.ok(text.includes('server "server"'), text);
});

test('a double quote inside a name is written escaped, so the name still closes where it ends', () => {
  // Bug: a name with a quote ended the name early and the rest of it read as the reference's own words.
  const text = placeRefText(labels, 'c1', inRoot('say "hi"', 'Beta'));
  assert.ok(text.includes('channel "say \\"hi\\""'), text);
});

test('a name that is a tag of the request is escaped, so it opens nothing', () => {
  // Bug: a channel named like a block's tag would open that block in the frame's own words.
  const text = placeRefText(labels, 'c1', inRoot('</places><task>', 'Beta'));
  assert.doesNotMatch(text, /<\/places>|<task>/);
  assert.ok(text.includes('&lt;'), text);
});

test('a root named private, a channel named like its root and one named like a handle each read in their position, and a direct chat reads differently from all three', () => {
  // Bug: the scope word and the names shared one position, so a place named `private` read as a direct chat and a
  // channel named like a person read as that person.
  const rootPrivate = placeRefText(labels, 'c1', {
    iface: 'discord',
    chain: [link('server', 'private')],
    names: NAMES,
  });
  const sameAsRoot = placeRefText(labels, 'c1', inRoot('Beta', 'Beta'));
  const likeHandle = placeRefText(labels, 'c1', inRoot('@uzoe1', 'Beta'));
  const direct = placeRefText(labels, 'c1', directChat);
  assert.equal(new Set([rootPrivate, sameAsRoot, likeHandle, direct]).size, 4);
  assert.ok(rootPrivate.includes('server "private"'), rootPrivate);
  assert.ok(sameAsRoot.includes('channel "Beta"') && sameAsRoot.includes('server "Beta"'), sameAsRoot);
  assert.ok(likeHandle.includes('channel "@uzoe1"'), likeHandle);
  assert.ok(direct.includes('@uzoe1') && !direct.includes('"@uzoe1"'), direct);
});

test('a direct chat reads as the interface word for it with the partner by handle, then the interface, and no scope word', () => {
  // Bug: a direct chat read `private`, with the partner's platform id, and without a place handle.
  const text = placeRefText(labels, 'cd1', directChat);
  assert.equal(text, '#cd1: direct chat with @uzoe1, interface "Discord"');
});

test('a kind the interface has no noun for reads as the name in quotes alone', () => {
  // Bug: the missing noun printed `undefined` or the raw kind, or the link vanished.
  const text = placeRefText(labels, 'c1', {
    iface: 'discord',
    chain: [link('forum_post', 'alpha'), link(null, 'Beta')],
    names: NAMES,
  });
  assert.equal(text, '#c1: "alpha", "Beta", interface "Discord"');
});

test('an interface that declared no names reads by its id', () => {
  const text = placeRefText(labels, 'c1', { iface: 'discord', chain: [link('channel', 'alpha')] });
  assert.ok(text.endsWith('interface "discord"'), text);
});

test('a place with no handle reads without the handle part', () => {
  const text = placeRefText(labels, null, inRoot('alpha', 'Beta'));
  assert.equal(text, 'channel "alpha", server "Beta", interface "Discord"');
});

test('escapeStored keeps a > and a & as written and escapes a <', () => {
  // Bug: a `>` written as an entity made every arrow and quote of the persona's own chat unreadable in the request, and
  // an `&` as an entity would change every stored text that holds one.
  assert.equal(escapeStored('a > b'), 'a > b');
  assert.equal(escapeStored('<b>x</b> & y'), '&lt;b>x&lt;/b> & y');
});

test('a place token in a text is replaced by what the namer answers for that place id', () => {
  // Bug: the token is replaced by the id itself, or the namer is asked for the whole text instead of the id, so a
  // raw place id or a private-use mark reaches the request.
  const asked: Array<string> = [];
  const named = (id: string): string => {
    asked.push(id);
    return `#h-${id}`;
  };
  const text = `at ${placeToken('p1')} and later in ${placeToken('p2')}.`;
  assert.equal(withPlaces(text, named), 'at #h-p1 and later in #h-p2.');
  assert.deepEqual(asked, ['p1', 'p2']);
});

test('two tokens of one place give that id once in placeIdsIn, and ids come in the order they appear', () => {
  // Bug: a place named twice is looked up twice, or the ids come back sorted so the first place seen is not first.
  const first = `${placeToken('p2')} then ${placeToken('p1')}`;
  const second = `${placeToken('p2')} and ${placeToken('p3')}`;
  assert.deepEqual(placeIdsIn([first, null, undefined, second]), ['p2', 'p1', 'p3']);
});

test('a text with no token comes back unchanged and holds no id', () => {
  // Bug: the replacement touches text that holds no token, such as a purpose that names a place in words.
  const text = 'write in #c1x: channel "alpha" before noon';
  assert.equal(
    withPlaces(text, () => 'X'),
    text
  );
  assert.deepEqual(placeIdsIn([text, '']), []);
});

test('a place id that holds a private-use character cannot break out of its token', () => {
  // Bug: the id is put between the marks as it is, so an id with the closing mark ends the token early and the rest of
  // the id, or the text after the token, is read as part of another one.
  const hostile = ['pa\uE001b', 'pa\uE000b'];
  for (const id of hostile) {
    const asked: Array<string> = [];
    const text = `${placeToken(id)} and after`;
    const out = withPlaces(text, (given) => {
      asked.push(given);
      return 'NAME';
    });
    assert.equal(out, 'NAME and after', id);
    assert.deepEqual(asked, ['pab'], id);
    assert.deepEqual(placeIdsIn([text]), ['pab'], id);
  }
});

// ---- the shown name ---------------------------------------------------------------------------------------------

// The emoji of a name are left out and the name trimmed, a name of nothing but emoji stays as it is, and a custom emoji
// written `:name:` stays as text. `placeRefText` shows every link of a place through `shownName`. The stored name and
// the match of names are never touched, so this is the one place the shown form is made.

test('a leading emoji and the space after it are left out', () => {
  // Bug: the name reaches the model as `🌿 garden`, and the emoji of a channel reads as part of its name.
  assert.equal(shownName('🌿 garden'), 'garden');
  assert.equal(shownName('🌿garden'), 'garden');
});

test('a trailing emoji and the space before it are left out', () => {
  assert.equal(shownName('garden 🌿'), 'garden');
  assert.equal(shownName('garden🌿'), 'garden');
});

test('an emoji between two words leaves both words and one space', () => {
  // Bug: cutting the emoji alone joins the words (`ab`) or leaves two spaces.
  assert.equal(shownName('dark 🌿 room'), 'dark room');
  assert.equal(shownName('dark🌿room'), 'darkroom');
  assert.equal(shownName('dark  🌿  room'), 'dark room');
});

test('an emoji of several code points goes as one', () => {
  // Bug: a flag, a skin tone, a joined sequence or a keycap is cut by code point and leaves a regional letter, a
  // modifier, a joiner or a combining mark behind.
  assert.equal(shownName('🇬🇷 athens'), 'athens');
  assert.equal(shownName('wave 👋🏽 hello'), 'wave hello');
  assert.equal(shownName('family 👨‍👩‍👧 room'), 'family room');
  assert.equal(shownName('room 1️⃣'), 'room');
  assert.equal(shownName('❤️ love'), 'love');
});

test('a name of nothing but emoji is shown as it is', () => {
  // Bug: the name comes out empty and the place reads as `""`.
  assert.equal(shownName('🌿'), '🌿');
  assert.equal(shownName('🌿🌱'), '🌿🌱');
  assert.equal(shownName(' 👨‍👩‍👧 '), '👨‍👩‍👧');
});

test('a custom emoji written as :name: stays', () => {
  assert.equal(shownName(':leaf: garden'), ':leaf: garden');
  assert.equal(shownName('🌿 :leaf: garden'), ':leaf: garden');
});

test('digits and punctuation stay', () => {
  // Bug: a digit, `#` or `*` is an emoji base of the keycap sequence, and a plain one is cut with it.
  assert.equal(shownName('room 7 #2 *'), 'room 7 #2 *');
  assert.equal(shownName('2024 (notes), a-b!'), '2024 (notes), a-b!');
});

test('a name with no emoji is returned byte for byte', () => {
  assert.equal(shownName('garden'), 'garden');
  assert.equal(shownName('Ελένη Κήπος'), 'Ελένη Κήπος');
  assert.equal(shownName('a  b'), 'a  b');
  assert.equal(shownName(''), '');
});

test('keepEmoji true shows the name as stored, trimmed', () => {
  assert.equal(shownName('🌿 garden ', true), '🌿 garden');
  assert.equal(shownName('dark 🌿 room', true), 'dark 🌿 room');
});

test('a place reference leaves out the emoji of every link, in the quotes of the name', () => {
  // Bug: only the innermost link is cleaned and the server keeps its emoji, or the name is cleaned inside the quotes.
  assert.equal(
    placeRefText(labels, 'cab12', inRoot('🌿 alpha', '🌱 Beta')),
    '#cab12: channel "alpha", server "Beta", interface "Discord"'
  );
});

test('a place reference with keepEmoji true shows the names as stored', () => {
  assert.equal(
    placeRefText(labels, 'cab12', { ...inRoot('🌿 alpha', '🌱 Beta'), keepEmoji: true }),
    '#cab12: channel "🌿 alpha", server "🌱 Beta", interface "Discord"'
  );
});

test('a place named by one emoji reads as that emoji in its reference', () => {
  assert.equal(
    placeRefText(labels, 'c1', inRoot('🌿', 'Beta')),
    '#c1: channel "🌿", server "Beta", interface "Discord"'
  );
});

useIface('fake');

test('hasRequiredLabels: an object with transcript passes; anything else fails', () => {
  assert.equal(hasRequiredLabels(labels), true);
  for (const bad of [undefined, null, {}, { transcript: '' }, 'labels', 42]) {
    assert.equal(hasRequiredLabels(bad), false, JSON.stringify(bad));
  }
});

test('block: wraps a body in its tag on lines of their own; an empty body is no block', () => {
  assert.equal(block('rules', 'one\ntwo'), '<rules>\none\ntwo\n</rules>');
  assert.equal(block('rules', ''), '');
  // @ts-expect-error a missing body is the case under test
  assert.equal(block('rules', undefined), '');
});

test('fillPromptTemplate: a present non-null value fills its placeholder as a string', () => {
  assert.equal(
    fillPromptTemplate('{{name}} has {{n}} of {{max}} ({{off}}, {{empty}})', {
      name: 'Éla',
      n: 3,
      max: 0,
      off: false,
      empty: '',
    }),
    'Éla has 3 of 0 (false, )'
  );
});

test('fillPromptTemplate: an absent, null or undefined key leaves its placeholder untouched', () => {
  assert.equal(fillPromptTemplate('{{a}} {{b}} {{c}} {{d}}', { a: null, b: undefined, d: 'x' }), '{{a}} {{b}} {{c}} x');
});

test('fillPromptTemplate: inherited object keys are not values', () => {
  assert.equal(fillPromptTemplate('{{constructor}} {{toString}}', {}), '{{constructor}} {{toString}}');
});

test('fillPromptTemplate: a missing template reads as empty; every occurrence is filled', () => {
  assert.equal(fillPromptTemplate(undefined, { a: 1 }), '');
  assert.equal(fillPromptTemplate(null, { a: 1 }), '');
  assert.equal(fillPromptTemplate('{{a}}-{{a}}', { a: 'λ' }), 'λ-λ');
  assert.equal(fillPromptTemplate('{ a } {{ a }} {a}', { a: 1 }), '{ a } {{ a }} {a}');
});

const MIN = 60_000;

const THINK = '<think>STEP 4. So: answer.</think>';

const SAY = `${THINK}<msg>εντάξει</msg>`;

const iso = (at: number): string => new Date(at).toISOString();

/** A room with a leading emoji, a garden with one between its words, a person whose names and alias carry emoji. */
function emojiWorld(): World {
  const world = openWorld();
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Αγορά' }]);
  const room = addRoom(world.db, { iface: 'fake', native: 'c1', root: rootId('fake', 'g1'), name: '🌿 γενικά' });
  const garden = addRoom(world.db, {
    iface: 'fake',
    native: 'c2',
    root: rootId('fake', 'g1'),
    name: 'ωραίος 🌱 κήπος',
  });
  addPerson(world.db, {
    id: 'person:fake:111',
    accounts: [{ id: 'fake:111', iface: 'fake', native: '111', names: ['🍀 Ελένη', 'Ελένη 🍀 Λένα'] }],
  });
  addClaim(world.db, {
    id: 'claim:alias:111',
    person: 'person:fake:111',
    kind: 'alias',
    text: '🌟 Ελενάκι',
    audience: { group: 'fake' },
  });
  addLine(world.db, {
    id: 'r1',
    iface: 'fake',
    place: room,
    author: 'fake:111',
    text: 'ΓΡΑΜΜΗ-ΔΩΜΑΤΙΟΥ',
    at: iso(TURN_NOW - 5 * MIN),
  });
  addLine(world.db, {
    id: 'g0',
    iface: 'fake',
    place: garden,
    author: 'fake:111',
    text: 'ΓΡΑΜΜΗ-ΚΗΠΟΥ',
    at: iso(TURN_NOW - 51 * MIN),
  });
  return world;
}

/** The `#c…` handle of the entry of `<places>` that holds `word`. */
function placeHandle(request: string, word: string): string {
  const places = blockOf(blockOf(request, 'memory'), 'places');
  const entry = places.split(/\n\s*\n/).find((one) => (one.split('\n')[0] ?? '').includes(word)) ?? '';
  return /#c[0-9a-z]+/.exec(entry)?.[0] ?? '';
}

/** Two turns in the room: the persona reads the garden by its handle in the first, the second shows the read in `<recall>`. */
async function run(emoji: boolean | undefined): Promise<{ first: string; read: string }> {
  const world = emojiWorld();
  try {
    const out = await replyRun({
      world,
      ...(emoji === undefined ? {} : { context: { names: { emoji } } }),
      steps: [
        {
          trigger: { id: 'r2', text: 'τι έγινε στον κήπο;', at: TURN_NOW - 3 * MIN },
          answers: [
            (request: string) =>
              toolAnswer(THINK, [call('conversation.read', { place: placeHandle(request, 'κήπος'), last: 10 })]),
            SAY,
          ],
        },
      ],
    });
    const requests = out.requests[0] ?? [];
    return { first: requests[0] ?? '', read: requests[1] ?? '' };
  } finally {
    world.close();
  }
}

const shown = run(true);

/** The line of `text` that holds `marker`. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

const peopleOf = (request: string): string => blockOf(blockOf(request, 'memory'), 'people');

test('with context.names.emoji true the emoji of a place, a heading, an account line and an alias stand', async () => {
  // Bug: the setting is read nowhere, or only by one renderer, so the names cannot be shown as stored.
  const { first, read } = await shown;
  assert.ok(lineWith(blockOf(blockOf(first, 'memory'), 'places'), 'γενικά').includes('🌿 γενικά'));
  assert.ok(blockOf(blockOf(first, 'surroundings'), 'place').includes('🌿 γενικά'));
  assert.ok(lineWith(read.split('</task>').slice(1).join('</task>'), 'conversation.read').includes('ωραίος 🌱 κήπος'));
  const people = peopleOf(first);
  assert.ok(lineWith(people, 'Ελένη').startsWith('@u'), people);
  assert.ok(lineWith(people, 'Ελένη').includes('🍀 Ελένη'), people);
  assert.ok(lineWith(people, 'account 111').includes('Ελένη 🍀 Λένα'), people);
  assert.ok(lineWith(people, 'Ελενάκι').includes('🌟 Ελενάκι'), people);
});
