// Tests for the anchored chat window of src/behavior/prompt.js#buildRequest
// (features.anchoredWindow): lines of the current channel older than the
// count-based window that matter -- the reply parents and the persona's saved
// stretch, open requests to her ranked first -- shown as anchors in `<earlier>`,
// deduplicated against the window, capped, and nothing at all with the switch off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, userText as contentText } from '../src/behavior/prompt.js';
import { fill, formatClock } from '../src/format.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const TZ = 'Europe/Athens';
const HERE = 'c1';
const SELF = 'self-id';

function fakeConfig({ features = {}, caps = {}, participation = {} } = {}) {
  return {
    bot: { timezone: TZ },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      ageAfterMinutes: 60,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500, recent: 1200, ...caps },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      tempo: { liveMessages10min: 4, deadSilenceMinutes: 45 },
    },
    features: { vision: true, relationships: true, episodes: true, lore: true, recent: true, participation: true, anchoredWindow: true, ...features },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
    memory: { recentHours: 72 },
    participation: { hours: 72, shown: 4, perChannel: 2, episodeChars: 1800, earlierHours: 3, earlierShown: 3, ...participation },
  };
}

const prompts = {
  'system-prompt': 'SYSTEM for {{name}}',
  'character-card': 'CARD',
  rules: 'RULES',
  format: 'FORMAT',
  reply: 'Called by {{author}}.',
  interject: 'INTERJECT',
  initiate: 'INITIATE',
  labels,
};

function chatLine(id, ts, overrides = {}) {
  return { id, ts, channelId: HERE, authorId: `a-${id}`, authorName: `User${id}`, self: false, content: `message ${id}`, attachments: [], stickers: [], replyToId: null, ...overrides };
}

/** A reply parent the turn fetched from outside the window (src/behavior/turn.js#withReplyParents). */
const parentLine = (id, ts, overrides = {}) => chatLine(id, ts, { replyParent: true, ...overrides });

/** A stored participation message. */
function stored(id, ts, { name = 'Ana', authorId = 'u1', self = false, text = `γραμμή ${id}`, replyTo = null } = {}) {
  return { id, ts, authorId: self ? SELF : authorId, name: self ? 'Zoë' : name, self, text, replyTo, caption: null };
}

const episode = (id, messages) => ({ id, channelId: HERE, continues: null, messages });

function input(overrides = {}) {
  const trigger = chatLine('m1', NOW - MIN, { authorName: 'Nikos', content: 'θυμάσαι;' });
  return {
    config: fakeConfig(),
    prompts,
    calibrator: { ratio: 1, apply: (n) => n },
    mode: 'reply',
    now: NOW,
    selfName: 'Zoë',
    selfId: SELF,
    history: [trigger],
    neighbors: [],
    trigger,
    triggerKind: 'mention',
    guildMemory: {},
    interlocutor: null,
    otherProfiles: [],
    channels: [{ id: HERE, name: 'general' }],
    currentChannelId: HERE,
    participation: { state: { nextId: 20, episodes: [] }, pickedIds: [], audience: () => true, channelName: () => null },
    ...overrides,
  };
}

const textOf = (request) => contentText(request.messages[1].content);
const blockOf = (text, tag) => {
  const start = text.indexOf(`<${tag}>\n`);
  return start === -1 ? null : text.slice(start + tag.length + 3, text.indexOf(`\n</${tag}>`, start));
};
const clock = (ts) => formatClock(ts, TZ, labels.locale);
const header = fill(labels.participation.earlierHeader, { hours: 3 });
const selfLabel = fill(labels.self, { name: 'Zoë' });

/** A window of two lines whose trigger replies to a parent two hours old. */
function parentCase() {
  const parent = parentLine('p1', NOW - 2 * HOUR, { authorName: 'Bob', content: 'ποιος έχει το κλειδί;' });
  const first = chatLine('m0', NOW - 10 * MIN);
  const trigger = chatLine('m1', NOW - MIN, { authorName: 'Nikos', content: 'εγώ', replyToId: 'p1' });
  return { parent, history: [parent, first, trigger], trigger };
}

test('anchors: the switch off -- the reply parent stays at the head of <chat>, no <earlier>, the same request as without the switch', () => {
  const { history, trigger } = parentCase();
  const state = { nextId: 20, episodes: [episode('p7', [stored('e1', NOW - 40 * MIN, { self: true, text: 'ναι' })])] };
  const off = (features) => buildRequest(input({ config: fakeConfig({ features }), history, trigger, participation: { state, audience: () => true } }));
  const request = off({ anchoredWindow: false });
  const text = textOf(request);
  assert.equal(blockOf(text, 'earlier'), null);
  assert.ok(blockOf(text, 'chat').includes(`#1 [${clock(NOW - 2 * HOUR)}`), 'the parent is the chat\'s first line');
  assert.deepEqual(request.messages, off({ anchoredWindow: undefined }).messages, 'a missing key is off');
  // With the switch off no stored stretch of this channel changes anything.
  const bare = buildRequest(input({ config: fakeConfig({ features: { anchoredWindow: false } }), history, trigger, participation: { state: { nextId: 20, episodes: [] }, audience: () => true } }));
  assert.deepEqual(request.messages, bare.messages);
  assert.deepEqual(request.seen.parents, ['p1']);
});

test('anchors: a reply parent leaves <chat> for <earlier> with its number, the chat still names it, no gap marker from it', () => {
  const { history, trigger } = parentCase();
  const request = buildRequest(input({ history, trigger }));
  const text = textOf(request);
  assert.equal(blockOf(text, 'earlier'), [header, `#1 [${clock(NOW - 2 * HOUR)}] Bob: ποιος έχει το κλειδί;`].join('\n'));
  const chat = blockOf(text, 'chat');
  assert.ok(chat.includes('(replying to #1, Bob: '), 'the trigger names the parent by its number');
  assert.ok(!chat.includes(`#1 [`), 'the parent line is not in the chat');
  assert.ok(chat.includes('#2 [') && chat.includes('#3 ['), 'the window keeps its numbers');
  assert.ok(!chat.includes('passed ---'), 'no gap marker measured from the moved parent');
  assert.equal(request.idByIndex.get(1), 'p1', 'her reply to #1 still lands on the parent');
  assert.deepEqual(request.seen.parents, ['p1']);
  assert.equal(request.seen.messageIds[0], 'p1');
  // In the tail, after <participation>'s place and before <chat>; never in a cached part.
  const parts = request.messages[1].content.filter((part) => part.type === 'text');
  assert.ok(parts.filter((part) => part.cacheSegment).every((part) => !part.text.includes('<earlier>')));
  assert.ok(!parts.at(-1).cacheSegment && parts.at(-1).text.indexOf('<earlier>') < parts.at(-1).text.indexOf('<chat>'));
});

test('anchors: a parent the saved stretch already holds is shown once, inside it, with its number', () => {
  const { history, trigger } = parentCase();
  const state = {
    nextId: 20,
    episodes: [
      episode('p7', [
        stored('p1', NOW - 2 * HOUR, { name: 'Bob', authorId: 'a-p1', text: 'ποιος έχει το κλειδί;' }),
        stored('e2', NOW - 2 * HOUR + MIN, { self: true, text: 'όχι εγώ' }),
        // Younger than the window's first line (m0): the window shows it already.
        stored('m0', NOW - 10 * MIN, { name: 'Userm0', text: 'message m0' }),
      ]),
    ],
  };
  const earlier = blockOf(textOf(buildRequest(input({ history, trigger, participation: { state, audience: () => true } }))), 'earlier');
  assert.equal(
    earlier,
    [header, `#1 [${clock(NOW - 2 * HOUR)}] Bob: ποιος έχει το κλειδί;`, `[${clock(NOW - 2 * HOUR + MIN)}] ${selfLabel}: όχι εγώ`].join('\n'),
  );
});

test('anchors: an open request to the persona is marked; a line of hers that answers it takes the mark away', () => {
  const asked = () =>
    episode('p7', [
      stored('e1', NOW - 50 * MIN, { self: true, text: 'θα το ζωγραφίσω' }),
      stored('e2', NOW - 49 * MIN, { replyTo: 'e1', text: 'πότε;' }),
    ]);
  const window = [chatLine('m0', NOW - 10 * MIN), chatLine('m1', NOW - MIN)];
  const run = (history) => blockOf(textOf(buildRequest(input({ history, trigger: history.at(-1), participation: { state: { nextId: 20, episodes: [asked()] }, audience: () => true } }))), 'earlier');
  assert.ok(run(window).includes(`Ana: πότε; ${labels.participation.earlierOpen}`), run(window));
  // Her window line posted by the turn that line started: answered.
  const answered = [window[0], chatLine('m2', NOW - 5 * MIN, { self: true, triggerId: 'e2' }), window[1]];
  assert.ok(!run(answered).includes(labels.participation.earlierOpen), run(answered));
  // A reply parent that mentions her, nobody of hers answering it: open too.
  const parent = parentLine('p1', NOW - 2 * HOUR, { authorName: 'Bob', content: 'μπορείς;', mentionedUserIds: [SELF] });
  const history = [parent, window[0], chatLine('m1', NOW - MIN, { replyToId: 'p1' })];
  assert.ok(run(history).includes(`Bob: μπορείς; ${labels.participation.earlierOpen}`), run(history));
  // Without the label the request is ranked the same and carries no mark.
  const quiet = buildRequest(input({ prompts: { ...prompts, labels: { ...labels, participation: { ...labels.participation, earlierOpen: '' } } }, history: window, trigger: window[1], participation: { state: { nextId: 20, episodes: [asked()] }, audience: () => true } }));
  assert.ok(blockOf(textOf(quiet), 'earlier').endsWith('Ana: πότε;'));
});

test('anchors: when the cap bites the trigger\'s parent and an open request win over a newer saved stretch', () => {
  const parent = parentLine('p1', NOW - 2 * HOUR, { authorName: 'Bob', content: 'ποιος έχει το κλειδί;' });
  const history = [parent, chatLine('m0', NOW - 10 * MIN), chatLine('m1', NOW - MIN, { replyToId: 'p1' })];
  const long = 'μακρύ κείμενο '.repeat(20);
  const state = {
    nextId: 20,
    episodes: [
      episode('p5', [stored('o1', NOW - 90 * MIN, { self: true, text: 'θα το φέρω' }), stored('o2', NOW - 89 * MIN, { replyTo: 'o1', text: 'περιμένω' })]),
      episode('p6', [stored('n1', NOW - 30 * MIN, { self: true, text: long }), stored('n2', NOW - 29 * MIN, { text: long })]),
    ],
  };
  const run = (caps) => buildRequest(input({ config: fakeConfig({ caps }), history, trigger: history.at(-1), participation: { state, audience: () => true } }));
  const all = blockOf(textOf(run({})), 'earlier');
  assert.ok(all.includes('κλειδί') && all.includes('περιμένω') && all.includes('μακρύ'), all);
  assert.ok(all.indexOf('κλειδί') < all.indexOf('περιμένω') && all.indexOf('περιμένω') < all.indexOf('μακρύ'), 'shown oldest first');
  const used = run({}).stats.earlier.used;
  const tight = blockOf(textOf(run({ earlier: used - 20 })), 'earlier');
  assert.ok(tight.includes('κλειδί') && tight.includes('περιμένω') && !tight.includes('μακρύ'), tight);
  const tighter = blockOf(textOf(run({ earlier: Math.ceil(used / 4) })), 'earlier');
  assert.ok(tighter.includes('κλειδί') && !tighter.includes('μακρύ'), tighter);
});

test('anchors: never in a private chat, nothing without the header label', () => {
  const { history, trigger } = parentCase();
  const priv = textOf(buildRequest(input({ history, trigger, privateChat: { userId: 'a-m1' }, triggerKind: 'private' })));
  assert.equal(blockOf(priv, 'earlier'), null);
  assert.ok(blockOf(priv, 'chat').includes('#1 ['), 'the parent stays in the chat');
  const unlabeled = textOf(buildRequest(input({ history, trigger, prompts: { ...prompts, labels: { ...labels, participation: { ...labels.participation, earlierHeader: '' } } } })));
  assert.equal(blockOf(unlabeled, 'earlier'), null);
  assert.ok(blockOf(unlabeled, 'chat').includes('#1 ['), 'without a block the parent is not lost');
});
