// Tests for src/memory/mentions.ts: fromTokens (the analyzer's id tokens back to names) and the word and channel
// matching, the form a teacher is stored in, and tokenIds. Pure, no I/O.
// The core's own stored mention grammar (`<@id>`) lives here; message links are the Discord package's
// (tests/interfaces/discord/collect.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEACHER_TOKEN_RE,
  channelCore,
  isWordChar,
  linkChannels,
  linkMessageNumbers,
  matchChannel,
  fromTokens,
  occursAsWholeWord,
  occursAsWordStem,
  tokenIds,
} from '../../../src/memory/mentions.ts';

const ID_A = '123456789012345678';
const ELENI = '111111111111111111';
const NIKOS = '222222222222222222';

// ---- fromTokens ---------------------------------------------------------------

test("fromTokens: chat mode resolves a token to the member's current name alone", () => {
  const text = `<@${ID_A}> helped with the raid`;
  const out = fromTokens(text, (id) => (id === ID_A ? 'Vertex' : null), 'chat');
  assert.equal(out, 'Vertex helped with the raid');
});

test('fromTokens: analyzer mode resolves a token to "name (id:...)"', () => {
  const text = `<@${ID_A}> helped`;
  const out = fromTokens(text, (id) => (id === ID_A ? 'Vertex' : null), 'analyzer');
  assert.equal(out, `Vertex (id:${ID_A}) helped`);
});

test('fromTokens: an id nameOf cannot resolve is left as the bare token', () => {
  const text = `<@${ID_A}> helped`;
  assert.equal(
    fromTokens(text, () => null, 'chat'),
    text
  );
  assert.equal(
    fromTokens(text, () => undefined, 'analyzer'),
    text
  );
});

// ---- occursAsWholeWord ----------------------------------------------------------

test('occursAsWholeWord: matches a whole word, case must already match (caller lowercases)', () => {
  assert.equal(occursAsWholeWord('vertex helped today', 'vertex'), true);
  assert.equal(occursAsWholeWord('vertexes helped today', 'vertex'), false);
});

test('occursAsWholeWord: an empty needle never matches', () => {
  assert.equal(occursAsWholeWord('anything', ''), false);
});

test('occursAsWholeWord: an occurrence inside a longer word does not hide a later whole one', () => {
  assert.equal(occursAsWholeWord('vertexes and vertex', 'vertex'), true);
});

// ---- isWordChar / ID_DIGITS ---------------------------------------------------------

test('isWordChar: letters, digits and underscore in any script; punctuation, space and undefined are not', () => {
  for (const ch of ['a', 'é', 'λ', '7', '_']) assert.equal(isWordChar(ch), true, ch);
  for (const ch of [' ', ',', '-', '@', undefined]) assert.equal(isWordChar(ch), false, String(ch));
});

// ---- TEACHER_TOKEN_RE ---------------------------------------------------------------------

test('TEACHER_TOKEN_RE: exactly one <@id> token, the form a teacher is stored in', () => {
  assert.equal(TEACHER_TOKEN_RE.exec(`<@${ID_A}>`)?.[1], ID_A);
  for (const value of [` <@${ID_A}>`, `<@!${ID_A}>`, `Νίκος (id:${ID_A})`]) {
    assert.equal(TEACHER_TOKEN_RE.test(value), false, value);
  }
  assert.equal(TEACHER_TOKEN_RE.global, false, 'no g flag: a shared pattern keeps no lastIndex between calls');
});

// ---- linkChannels -----------------------------------------------------------

const CHANNEL_A = '323456789012345678';
const CHANNEL_B = '423456789012345678';
const CHANNEL_C = '523456789012345678';

test('linkChannels: #name of a known channel becomes its <#id> link, every occurrence', () => {
  const channels = [{ id: CHANNEL_A, name: 'γενικά' }];
  assert.equal(linkChannels('δες στο #γενικά, ναι #γενικά', channels), `δες στο <#${CHANNEL_A}>, ναι <#${CHANNEL_A}>`);
});

test('linkChannels: a #name inside a URL stays as written; the same name after it is linked', () => {
  const channels = [{ id: CHANNEL_A, name: 'art' }];
  const url = 'https://example.org/gallery/#art?ref=x';
  assert.equal(linkChannels(`δες ${url} στο #art`, channels), `δες ${url} στο <#${CHANNEL_A}>`);
  assert.equal(linkChannels(`<${url}> #art`, channels), `<${url}> <#${CHANNEL_A}>`);
});

test('linkChannels: a longer name is matched before a name that is its prefix', () => {
  const channels = [
    { id: CHANNEL_A, name: 'art' },
    { id: CHANNEL_B, name: 'art-τέχνη' },
  ];
  assert.equal(linkChannels('#art-τέχνη και #art', channels), `<#${CHANNEL_B}> και <#${CHANNEL_A}>`);
});

test('linkChannels: no link inside a word or when the name runs on into a word', () => {
  const channels = [{ id: CHANNEL_A, name: 'art' }];
  assert.equal(linkChannels('a#art #artistic #art_x', channels), 'a#art #artistic #art_x');
  assert.equal(linkChannels('(#art)', channels), `(<#${CHANNEL_A}>)`);
});

test('linkChannels: names with emoji and Greek letters link; an existing <#id> is left alone', () => {
  const channels = [
    { id: CHANNEL_A, name: '🎮παιχνίδια' },
    { id: CHANNEL_C, name: 'μουσική' },
  ];
  assert.equal(
    linkChannels('#🎮παιχνίδια ή <#999999999999999999>', channels),
    `<#${CHANNEL_A}> ή <#999999999999999999>`
  );
  assert.equal(linkChannels(`<#${CHANNEL_C}> #μουσική`, channels), `<#${CHANNEL_C}> <#${CHANNEL_C}>`);
});

test('linkChannels: a name written with other or no leading emoji links by its core', () => {
  const channels = [
    { id: CHANNEL_A, name: '💖ανιμε' },
    { id: CHANNEL_C, name: 'μουσική' },
  ];
  assert.equal(linkChannels('δες #🍡ανιμε τώρα', channels), `δες <#${CHANNEL_A}> τώρα`);
  assert.equal(linkChannels('δες #ανιμε, ναι', channels), `δες <#${CHANNEL_A}>, ναι`);
  assert.equal(linkChannels('#💖ανιμε', channels), `<#${CHANNEL_A}>`);
  // Case and accents fold; trailing emoji of the written name go with it; punctuation stays.
  assert.equal(linkChannels('#🎵ΜΟΥΣΙΚΗ🎶!', channels), `<#${CHANNEL_C}>!`);
  // The core still ends at a word boundary, and nothing links after a word character or '<'.
  assert.equal(linkChannels('#ανιμες a#ανιμε', channels), '#ανιμες a#ανιμε');
});

test('linkChannels: two channels sharing a core link neither by it; an exact name still wins', () => {
  const channels = [
    { id: CHANNEL_A, name: '💖ανιμε' },
    { id: CHANNEL_B, name: '🍡ανιμε' },
  ];
  assert.equal(linkChannels('#🎀ανιμε και #ανιμε', channels), '#🎀ανιμε και #ανιμε');
  assert.equal(linkChannels('#🍡ανιμε', channels), `<#${CHANNEL_B}>`);
});

test('matchChannel: exact name first, then the one channel with the same core; several -> ambiguous', () => {
  const channels = [
    { id: 'a', name: '💖ανιμε' },
    { id: 'b', name: 'γενικά' },
    { id: 'c', name: '🍡κουζίνα' },
    { id: 'd', name: '🍰κουζίνα' },
  ];
  // Each of these names resolves to one channel; the cast reads its id out of the three-way result.
  assert.equal((matchChannel('💖ανιμε', channels) as { id: string }).id, 'a');
  assert.equal((matchChannel('🍡Ανιμέ', channels) as { id: string }).id, 'a');
  assert.equal((matchChannel('ΓΕΝΙΚΑ', channels) as { id: string }).id, 'b');
  assert.equal(
    (matchChannel('🍡κουζίνα', channels) as { id: string }).id,
    'c',
    'the exact name wins over a shared core'
  );
  assert.equal(matchChannel('κουζίνα', channels), 'ambiguous');
  assert.equal(matchChannel('τίποτα', channels), null);
  assert.equal(matchChannel('🍡', channels), null, 'no core, no match');
  assert.equal(channelCore('  💖Ανιμέ✨‍ '), 'ανιμε');
});

test('linkChannels: text without # comes back unchanged', () => {
  const channels = [{ id: CHANNEL_A, name: 'γενικά' }];
  assert.equal(linkChannels('γενικά χωρίς σύνδεσμο', channels), 'γενικά χωρίς σύνδεσμο');
  assert.equal(linkChannels('', channels), '');
  assert.equal(linkChannels('#γενικά', []), '#γενικά');
});

// ---- linkMessageNumbers -----------------------------------------------------

const jump = (n: number) => (n === 93 ? 'https://chat.example/m/3' : n === 7 ? 'https://chat.example/m/8' : null);

test('linkMessageNumbers: a mapped #n becomes its message link', () => {
  assert.equal(linkMessageNumbers('see #93 there', jump), 'see https://chat.example/m/3 there');
  assert.equal(linkMessageNumbers('#93', jump), 'https://chat.example/m/3');
});

test('linkMessageNumbers: an unmapped number stays', () => {
  assert.equal(linkMessageNumbers('#5 in the charts', jump), '#5 in the charts');
});

test('linkMessageNumbers: glued, entity and doubled forms stay', () => {
  for (const text of ['#93abc', '&#93;', 'x#93', '##93', '#93_', '<#93>', 'ά#93'])
    assert.equal(linkMessageNumbers(text, jump), text);
});

test('linkMessageNumbers: two numbers in one text both convert', () => {
  assert.equal(
    linkMessageNumbers('#93 and #7, #93.', jump),
    'https://chat.example/m/3 and https://chat.example/m/8, https://chat.example/m/3.'
  );
});

test('linkMessageNumbers: code spans and existing URLs stay', () => {
  const text = 'a `#93` b ```\n#93\n``` https://example.com/x#93 c';
  assert.equal(linkMessageNumbers(text, jump), text);
});

test('linkMessageNumbers: no resolver or no # returns the text', () => {
  // @ts-expect-error null where a resolver is a function, on purpose
  assert.equal(linkMessageNumbers('#93', null), '#93');
  assert.equal(linkMessageNumbers('plain', jump), 'plain');
});

// ---- occursAsWordStem ------------------------------------------------------------

test('occursAsWordStem: a form word of 5+ letters matches its inflected forms by stem', () => {
  assert.equal(occursAsWordStem('a few carolinas please', 'carolina'), true);
  assert.equal(occursAsWordStem('the reapers came', 'reaper'), true);
  assert.equal(occursAsWordStem('the reaper came', 'reaper'), true);
  assert.equal(occursAsWordStem('η θαλασσες ηταν ησυχες', 'θαλασσα'), true);
  assert.equal(occursAsWordStem('το χρωμα της θαλασσης', 'θαλασσα'), true);
  assert.equal(occursAsWordStem('caroline', 'carolina'), true, 'the stem is the word minus two letters');
  assert.equal(occursAsWordStem('a carol', 'carolina'), false, 'shorter than the stem');
});

test('occursAsWordStem: the stem is never shorter than four letters', () => {
  assert.equal(occursAsWordStem('the pastas', 'pasta'), true);
  assert.equal(occursAsWordStem('the past', 'pasta'), true);
  assert.equal(occursAsWordStem('a pas de deux', 'pasta'), false);
});

test('occursAsWordStem: a text word 4+ letters longer than the form word does not match', () => {
  assert.equal(occursAsWordStem('carolinaxyz', 'carolina'), true);
  assert.equal(occursAsWordStem('carolinawxyz', 'carolina'), false);
});

test('occursAsWordStem: a form word under five letters matches only as a whole word', () => {
  assert.equal(occursAsWordStem('the pier', 'pie'), false);
  assert.equal(occursAsWordStem('a pie', 'pie'), true);
  assert.equal(occursAsWordStem('two cats', 'cat'), false);
});

test('occursAsWordStem: a form word with digits matches only as a whole word', () => {
  assert.equal(occursAsWordStem('the model5000x', 'model5000'), false);
  assert.equal(occursAsWordStem('the model5000 is out', 'model5000'), true);
});

test('occursAsWordStem: a multi-word form matches consecutive inflected words in order', () => {
  assert.equal(occursAsWordStem('two carolinas reapers, hot', 'carolina reaper'), true);
  assert.equal(
    occursAsWordStem('carolinas, reapers', 'carolina reaper'),
    true,
    'punctuation between is only a boundary'
  );
  assert.equal(occursAsWordStem('carolinas and reapers', 'carolina reaper'), false, 'a word between breaks the phrase');
  assert.equal(occursAsWordStem('reapers carolinas', 'carolina reaper'), false, 'order matters');
});

test('occursAsWordStem: word boundaries are Unicode-aware; an empty form never matches', () => {
  assert.equal(occursAsWordStem('xcarolinas', 'carolina'), false);
  assert.equal(occursAsWordStem('(carolinas)', 'carolina'), true);
  assert.equal(occursAsWordStem('anything', ''), false);
  assert.equal(occursAsWordStem('anything', '   '), false);
});

// --- tokenIds ----------------------------------------------------------------

test('mentions: tokenIds lists each member id of the tokens once, in order of appearance', () => {
  assert.deepEqual(tokenIds(`<@${NIKOS}> και <@${ELENI}>, ξανά <@${NIKOS}> και <@123> και (id:${ELENI})`), [
    NIKOS,
    ELENI,
  ]);
});

// Tests for the channel handles: the handle of a channel (src/behavior/handles.ts, `#` + `c` +
// base-36 digits of the id's hash, distinct from a member's), a channel a line mentions carrying its handle
// (src/format.ts), the persona's `#handle` becoming `<#id>` (src/memory/mentions.ts#linkChannels) and resolving exactly in a
// skill call (src/tools/executors.ts#resolveCall), the name matching kept behind it. Pure; fake prompts and config.

const GENERAL = '800000000000000101';
const NEWS = '800000000000000202';
const KITCHEN = '800000000000000303';

const CHANNELS = [
  { id: NEWS, name: '💖νέα' },
  { id: GENERAL, name: 'γενικά' },
  { id: KITCHEN, name: 'κουζίνα', category: 'Κοινότητα' },
];

test('linkChannels: an exact #handle links its channel first; a name still links behind it', () => {
  const handles = new Map([['c1a2b', KITCHEN]]);
  const known = CHANNELS.map(({ id, name }) => ({ id, name }));
  assert.equal(linkChannels('see #c1a2b and #γενικά', known, handles), `see <#${KITCHEN}> and <#${GENERAL}>`);
  assert.equal(linkChannels('#c1a2b.', [], handles), `<#${KITCHEN}>.`, 'handles alone, without the guild list');
  assert.equal(
    linkChannels('#c1a2bx #C1A2B https://x.test/#c1a2b', [], handles),
    '#c1a2bx #C1A2B https://x.test/#c1a2b',
    'only the whole token, as shown, never in a URL'
  );
  assert.equal(
    linkChannels('#c9999 #νέα', known, handles),
    `#c9999 <#${NEWS}>`,
    'an unknown handle stays text; the core match is kept'
  );
});
