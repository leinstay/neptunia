// Tests for src/behavior/prompt.ts: buildRequest, the one-shot LLM request
// assembler. Uses fake prompts/config/labels only -- never reads prompts/ or
// data/. tests/fixtures/labels.ts is an English fixture covering every key of
// the prompt contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  block,
  buildDrawPrompt,
  hasRequiredLabels,
  skillsInventoryText,
  fillPromptTemplate,
  userText as contentText,
  usesFollowUpTask,
} from '../src/behavior/prompt.ts';
import { buildRequest, type Built, type Part } from './fixtures/built-request.ts';
import { blockTags, bodyOf, userText } from './fixtures/prompt-text.ts';
import { profileStateFields, renderProfile } from './fixtures/profile-render.ts';
import { estimateTokens } from '../src/llm/tokens.ts';
import { SAFETY_MARGIN } from '../src/llm/budget.ts';

import { fill, formatClock, formatDate, formatDuration } from '../src/format.ts';
import { labels } from './fixtures/labels.ts';

import {
  F,
  MIN,
  NOW,
  V,
  baseInput,
  exactly,
  fakeConfig,
  fakePrompts,
  fieldsOf,
  makeMessage,
} from './fixtures/prompt-rig.ts';

test('buildRequest: system message is system-prompt + character-card + rules + format, joined', () => {
  const request = buildRequest(baseInput());
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[0].content, 'SYSTEM_TEXT for Nept\n\nCARD_TEXT\n\n- RULES_TEXT\n\nFORMAT_TEXT');
});

test('buildRequest: a reply in <chat> quotes its parent cut at a word to 80 characters', () => {
  // PR 7d: context.replyQuoteChars is the constant 80 (the production value).
  const parent = 'je préfère les penalties '.repeat(5).trim();
  const history = [
    makeMessage('1', NOW - 2 * MIN, { self: true, content: parent }),
    makeMessage('2', NOW - MIN, { replyToId: '1', content: 'ah bon' }),
  ];
  const request = buildRequest(baseInput({ history }));
  const text = contentText(request.messages[1].content);
  const quote = `${'je préfère les penalties '.repeat(3)}je…`;
  assert.ok(
    text.includes(`User2: ah bon ${fill(labels.transcript.replyTo, { index: 1, author: 'Nept (you)', quote })}`),
    text
  );
});

test('buildRequest: {{name}} is filled with selfName in every system part', () => {
  const request = buildRequest(
    baseInput({ prompts: fakePrompts({ 'system-prompt': 'Hi, I am {{name}}.', 'character-card': 'card of {{name}}' }) })
  );
  assert.ok(request.messages[0].content.includes('Hi, I am Nept.'));
  assert.ok(request.messages[0].content.includes('card of Nept'));
});

test('buildRequest: fills {{author}}, {{trigger}}, {{target}} and {{name}} in the task template', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention' }));
  const user = contentText(request.messages[1].content);
  assert.ok(user.includes(`Called by Alice, they ${labels.triggers.mention}. Answer #1 as Nept. Target: #1.`));
});

test('buildRequest: target is the #index of the trigger message in the transcript', () => {
  const m1 = makeMessage(1, NOW - 3 * MIN);
  const m2 = makeMessage(2, NOW - 2 * MIN);
  const trigger = makeMessage(3, NOW - MIN, { authorName: 'Bob' });
  const request = buildRequest(baseInput({ history: [m1, m2, trigger], trigger, triggerKind: 'reply' }));
  const user = contentText(request.messages[1].content);
  assert.ok(user.includes('Answer #3 as Nept. Target: #3.'));
});

// A follow-up (a classifier yes) and an untagged reply (a Discord reply to the persona with no
// typed tag, taggedCall false) take prompts['follow-up'] as their task; every other call keeps reply.md.
const FOLLOW_UP_TASK = 'FOLLOW_UP_TASK: {{author}} {{trigger}} at {{target}}; you are {{name}}.';

test('buildRequest: triggerKind "followUp" takes prompts["follow-up"] as its task, every placeholder filled, no reply.md text', () => {
  const m1 = makeMessage(1, NOW - 2 * MIN);
  const trigger = makeMessage(2, NOW - MIN, { authorName: 'Élodie' });
  const request = buildRequest(
    baseInput({
      prompts: fakePrompts({ 'follow-up': FOLLOW_UP_TASK }),
      history: [m1, trigger],
      trigger,
      triggerKind: 'followUp',
    })
  );
  const user = contentText(request.messages[1].content);
  assert.ok(user.includes(`FOLLOW_UP_TASK: Élodie ${labels.triggers.followUp} at #2; you are Nept.`), user);
  assert.ok(!user.includes('Called by'), 'reply.md is not used on a follow-up');
});

test('buildRequest: an untagged reply (taggedCall false) takes prompts["follow-up"] with the reply label', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Élodie' });
  const request = buildRequest(
    baseInput({
      prompts: fakePrompts({ 'follow-up': FOLLOW_UP_TASK }),
      history: [trigger],
      trigger,
      triggerKind: 'reply',
      taggedCall: false,
    })
  );
  const user = contentText(request.messages[1].content);
  assert.ok(user.includes(`FOLLOW_UP_TASK: Élodie ${labels.triggers.reply} at #1; you are Nept.`), user);
  assert.ok(!user.includes('Called by'));
});

test('buildRequest: a tagged reply, a reply without taggedCall, a mention and a name call keep reply.md', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Élodie' });
  const cases = [
    { triggerKind: 'reply', taggedCall: true },
    { triggerKind: 'reply' },
    { triggerKind: 'mention', taggedCall: false },
    { triggerKind: 'private', taggedCall: false },
  ];
  for (const extra of cases) {
    const request = buildRequest(
      baseInput({ prompts: fakePrompts({ 'follow-up': FOLLOW_UP_TASK }), history: [trigger], trigger, ...extra })
    );
    const user = contentText(request.messages[1].content);
    assert.ok(
      user.includes(
        `Called by Élodie, they ${(labels.triggers as Record<string, string | undefined>)[extra.triggerKind] ?? ''}. Answer #1 as Nept.`
      ),
      JSON.stringify(extra)
    );
    assert.ok(!user.includes('FOLLOW_UP_TASK'), JSON.stringify(extra));
  }
});

test('buildRequest: a follow-up in a private chat keeps reply.md', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Élodie' });
  const request = buildRequest(
    baseInput({
      prompts: fakePrompts({ 'follow-up': FOLLOW_UP_TASK }),
      history: [trigger],
      trigger,
      triggerKind: 'followUp',
      dmChat: { accountId: 'author-1' },
    })
  );
  const user = contentText(request.messages[1].content);
  assert.ok(user.includes('Called by Élodie'));
  assert.ok(!user.includes('FOLLOW_UP_TASK'));
});

test('buildRequest: without prompts["follow-up"] (missing or blank) a follow-up and an untagged reply use reply.md', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Élodie' });
  for (const followUp of [undefined, '', '   ']) {
    for (const extra of [{ triggerKind: 'followUp' }, { triggerKind: 'reply', taggedCall: false }]) {
      const request = buildRequest(
        baseInput({ prompts: fakePrompts({ 'follow-up': followUp }), history: [trigger], trigger, ...extra })
      );
      const user = contentText(request.messages[1].content);
      assert.ok(
        user.includes(
          `Called by Élodie, they ${(labels.triggers as Record<string, string | undefined>)[extra.triggerKind]}. Answer #1 as Nept.`
        ),
        JSON.stringify({ followUp, ...extra })
      );
    }
  }
});

// Slice 7: the routed turn is deleted, so its case left this test.
test('usesFollowUpTask: a follow-up or an untagged reply in reply mode, never private or another mode', () => {
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'followUp' }), true);
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'reply', taggedCall: false }), true);
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'reply', taggedCall: true }), false);
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'reply', taggedCall: null }), false);
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'mention', taggedCall: false }), false);
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'overheard' }), false);
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'followUp', dmChat: true }), false);
  assert.equal(usesFollowUpTask({ mode: 'interject', triggerKind: 'followUp' }), false);
});

// An overheard turn: a line about the persona, said to someone else or to the room.
const OVERHEARD_TASK = 'OVERHEARD_TASK: {{author}} {{trigger}} at {{target}}; you are {{name}}.';

test('buildRequest: triggerKind "overheard" takes prompts.overheard as its task, every placeholder filled, no reply.md text', () => {
  const m1 = makeMessage(1, NOW - 2 * MIN);
  const trigger = makeMessage(2, NOW - MIN, { authorName: 'Élodie' });
  const request = buildRequest(
    baseInput({
      prompts: fakePrompts({ overheard: OVERHEARD_TASK }),
      history: [m1, trigger],
      trigger,
      triggerKind: 'overheard',
    })
  );
  const user = contentText(request.messages[1].content);
  assert.ok(user.includes(`OVERHEARD_TASK: Élodie ${labels.triggers.overheard} at #2; you are Nept.`));
  assert.ok(!user.includes('Called by'), 'reply.md is not used on an overheard turn');
});

test('buildRequest: triggerKind "overheard" without prompts.overheard (missing or blank) uses the mode prompt with the overheard label', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Élodie' });
  for (const overheard of [undefined, '', '   ']) {
    const request = buildRequest(
      baseInput({ prompts: fakePrompts({ overheard }), history: [trigger], trigger, triggerKind: 'overheard' })
    );
    const user = contentText(request.messages[1].content);
    assert.ok(
      user.includes(`Called by Élodie, they ${labels.triggers.overheard}. Answer #1 as Nept.`),
      JSON.stringify(overheard)
    );
  }
});

// The turn a finished errand opens with no origin message (asked in an inner turn of hers).
const ERRAND_TASK = 'ERRAND_TASK: you are {{name}}, your errand ended.';

test('buildRequest: a task trigger kind without a trigger takes prompts.errand-result as its task; missing, the mode prompt; with a trigger, the reply task', () => {
  const m1 = makeMessage(1, NOW - 2 * MIN);
  const own = (overrides: Record<string, unknown> = {}) =>
    contentText(
      buildRequest(baseInput({ mode: 'interject', history: [m1], trigger: null, triggerKind: 'errand', ...overrides }))
        .messages[1].content
    );
  const withFile = own({ prompts: fakePrompts({ 'errand-result': ERRAND_TASK }) });
  assert.ok(withFile.includes('ERRAND_TASK: you are Nept, your errand ended.'), withFile.slice(-300));
  assert.ok(!withFile.includes('INTERJECT'), "interject.md is not the task of her own errand's end");
  for (const missing of [undefined, '', '  ']) {
    const user = own({ prompts: fakePrompts({ 'errand-result': missing }) });
    assert.ok(user.includes('INTERJECT'), `without the file the mode prompt applies (${JSON.stringify(missing)})`);
  }
  const trigger = makeMessage(2, NOW - MIN, { authorName: 'Élodie' });
  const answered = contentText(
    buildRequest(
      baseInput({
        prompts: fakePrompts({ 'errand-result': ERRAND_TASK }),
        history: [m1, trigger],
        trigger,
        triggerKind: 'errand',
      })
    ).messages[1].content
  );
  assert.ok(!answered.includes('ERRAND_TASK'), 'with the origin message the reply task text frames the result');
});

// --- cache segments: the stable part, the profiles, the tail ----------------------------

/** A scene with something in every segment: guild memory, a GIF library, a caller with history, a neighbour. */
function segmentScene({
  messageCount = 40,
  ...overrides
}: { messageCount?: number; triggerFields?: Record<string, unknown>; [key: string]: unknown } = {}) {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice', ...overrides.triggerFields });
  const interlocutor = {
    id: 'author-1',
    names: ['Alice'],
    character: 'talkative',
    interests: [
      {
        topic: 'chess',
        note: 'blitz',
        weight: 3,
        firstSeen: '2026-01-02T10:00:00.000Z',
        lastSeen: '2026-03-01T10:00:00.000Z',
      },
      {
        topic: 'tea',
        note: '',
        weight: 1,
        firstSeen: '2026-09-19T10:00:00.000Z',
        lastSeen: '2026-09-19T10:00:00.000Z',
      },
    ],
    details: [
      {
        id: 1,
        text: 'lives by the sea',
        weight: 2,
        firstSeen: '2026-02-01T10:00:00.000Z',
        lastSeen: '2026-09-20T09:30:00.000Z',
      },
    ],
    affinity: {
      score: 12,
      reason: 'kind words',
      history: [{ ts: '2026-09-19T08:00:00.000Z', delta: 3, reason: 'a gift' }],
    },
    episodes: [{ date: '2026-09-18', what: 'a long talk', quote: 'ναι', feeling: 'warm', weight: 2 }],
    messageCount,
  };
  const gifs = {
    nextId: 10,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: 'https://tenor.com/view/a-1',
        site: 'Tenor',
        name: 'A',
        itemId: 'k1',
        messageId: 'm1',
        placeId: 'c1',
        count: 4,
        last: NOW - 2 * 86_400_000,
        firstSeen: NOW - 9 * 86_400_000,
      },
      // Posted by the persona two hours ago: the own-post mark, with no age in it.
      k2: {
        id: 'g2',
        kind: 'link',
        url: 'https://tenor.com/view/b-2',
        site: 'Tenor',
        name: 'B',
        itemId: 'k2',
        messageId: 'm2',
        placeId: 'c1',
        count: 6,
        last: NOW - 2 * HOUR,
        firstSeen: NOW - 9 * 86_400_000,
        ownLast: NOW - 2 * HOUR,
        ownUses: 1,
      },
    },
    backfill: null,
  };
  return baseInput({
    // Unsure and stale marks on, so the profile carries every date-driven mark.
    config: fakeConfig({ memory: { interestStaleDays: 30, confirmAfter: 2 } }),
    history: [trigger],
    trigger,
    triggerKind: 'mention',
    interlocutor,
    placeMemory: {
      patterns: 'talks fast',
      self: ['likes games'],
      learned: [
        {
          id: 1,
          text: 'say hi first',
          weight: 2,
          firstSeen: '2026-09-01T10:00:00.000Z',
          lastSeen: '2026-09-10T10:00:00.000Z',
        },
      ],
    },
    gifs,
    channels: [{ id: 'c1', name: 'general', lastMessageAt: NOW - MIN, days: {} }],
    currentChannelId: 'c1',
    neighbors: [{ channelName: 'random', messages: [makeMessage(9, NOW - 5 * MIN)] }],
    ...overrides,
  });
}

test('renderProfile: the avatar line under features.avatars, full and compact; an avatar alone is nothing learned', () => {
  const fox = { hash: 'h1', text: 'an illustrated fox in a scarf', describedAt: null };
  const line = fill(labels.profile.avatar, { text: fox.text });
  const profile = { id: 'u1', names: ['Ελένη'], character: 'curious', avatar: fox };
  assert.ok(!renderProfile(profile, labels, {}).includes(line), 'off unless asked');
  assert.equal(
    renderProfile(profile, labels, { avatars: true }),
    ['## Ελένη', line, fill(labels.profile.character, { text: 'curious' })].join('\n')
  );
  assert.ok(renderProfile(profile, labels, { avatars: true, compact: true }).includes(line));
  assert.ok(
    renderProfile({ ...profile, avatar: { hash: null, default: true } }, labels, { avatars: true }).includes(
      labels.profile.avatarDefault
    )
  );
  assert.equal(
    renderProfile({ ...profile, avatar: { hash: 'h1' } }, labels, { avatars: true }),
    renderProfile(profile, labels, {}),
    'a broken field shows nothing'
  );
  const bare = { id: 'u2', names: ['Ilse'], avatar: fox };
  assert.equal(renderProfile(bare, labels, { avatars: true }), '', 'nothing learned and no attitude: not shown');
  assert.equal(
    renderProfile(bare, labels, { avatars: true, interlocutor: true }),
    ['## Ilse', line, labels.profile.unknown].join('\n')
  );
  const unlabelled = { ...labels, profile: { ...labels.profile, avatar: undefined } };
  assert.ok(!renderProfile(profile, unlabelled, { avatars: true }).includes(fox.text), 'no label, no line');
});

// --- the stable part: the senses that read only the config --------------------------------

const EMOJI_INDEX = [
  { id: '1', name: 'alpha' },
  { id: '2', name: 'beta' },
  { id: '3', name: 'gamma' },
];

/**
 * A turn with every senses line it can have on a server and a full `<emoji>` block: the
 * ranked list and an emoji of the chat that is not on it.
 */
function cacheScene({
  triggerFields,
  ...overrides
}: { triggerFields?: Record<string, unknown>; [key: string]: unknown } = {}) {
  return segmentScene({
    config: fakeConfig({ dm: { enabled: true } }),
    triggerFields: { content: 'ωραίο :pog:', emojis: [{ id: '9', name: 'pog' }], ...triggerFields },
    placeMemory: {
      patterns: 'talks fast',
      self: ['likes games'],
      emojiUsage: { 2: { name: 'beta', count: 5, last: NOW - HOUR } },
    },
    customEmoji: EMOJI_INDEX,
    mediaCache: { 'emoji:9': { text: 'a surprised cat face', ts: 1 }, 'emoji:2': { text: 'a dancing bean', ts: 1 } },
    channels: [{ id: 'c1', name: 'κουζίνα', lastMessageAt: NOW - MIN, days: {} }],
    drawOn: true,
    recallAvailable: true,
    searchAvailable: true,
    elsewhereDestination: { name: 'général' },
    selfreflectionChannel: 'ημερολόγιο',
    ...overrides,
  });
}

/** The top-level blocks of `text` as `{ tag, body }`, in order. */
function blocksOf(text: string) {
  return [...text.matchAll(/^<([a-z_]+)>\n([\s\S]*?)\n<\/\1>$/gm)].map((match) => ({ tag: match[1], body: match[2] }));
}

test('buildRequest: the stable part is byte-identical across the turns of a day, whatever the turn brings', () => {
  const base = buildRequest(cacheScene()).messages[1].content[0];
  const variants = {
    'three hours later': { now: NOW + 3 * HOUR },
    'another author': { triggerFields: { authorId: 'author-7', authorName: 'Bob' } },
    'another channel': {
      channels: [{ id: 'c2', name: 'κήπος', lastMessageAt: NOW - MIN, days: {} }],
      currentChannelId: 'c2',
    },
    'no server search left': { recallAvailable: false },
    'no emoji in the chat': { triggerFields: { content: 'γεια', emojis: [] } },
    'the emoji ranking moved': {
      placeMemory: {
        patterns: 'talks fast',
        self: ['likes games'],
        emojiUsage: { 3: { name: 'gamma', count: 9, last: NOW - MIN } },
      },
    },
  };
  for (const [name, overrides] of Object.entries(variants)) {
    const content = buildRequest(cacheScene(overrides)).messages[1].content;
    assert.equal(content[0].cacheSegment, 'stable', name);
    assert.equal(content[0].text, base.text, name);
  }
});

test('profileStateFields: the message count is rounded down, to tens from 10 and to hundreds from 100, as it is below 10, none without; never in <people>', () => {
  const profile = (messageCount: unknown) => ({ id: 'p1', names: ['Zoé'], character: 'calme', messageCount });
  const shown = (messageCount: unknown) => fieldsOf(profileStateFields(profile(messageCount), labels))[F.messages];
  assert.equal(shown(10), '10');
  assert.equal(shown(47), '40');
  assert.equal(shown(99), '90');
  assert.equal(shown(100), '100');
  assert.equal(shown(1_234), '1200');
  assert.equal(shown(12_999), '12900');
  assert.equal(shown(7), '7');
  for (const none of [0, undefined, null, -5, Number.NaN, '50']) assert.equal(shown(none), V.none, String(none));
  // A compact profile's entry has no count; a profile never has one.
  assert.deepEqual(profileStateFields(profile(500), labels, { compact: true }), []);
  assert.equal(renderProfile(profile(500), labels, { interlocutor: true }), '## Zoé\ncharacter: calme');
});

test('buildRequest: throws a clear error when prompts.labels is missing', () => {
  assert.throws(() => buildRequest(baseInput({ prompts: fakePrompts({ labels: undefined }) })), /labels/);
});

test('hasRequiredLabels: an object with transcript passes; anything else fails', () => {
  assert.equal(hasRequiredLabels(labels), true);
  for (const bad of [undefined, null, {}, { transcript: '' }, 'labels', 42]) {
    assert.equal(hasRequiredLabels(bad), false, JSON.stringify(bad));
  }
});

test('buildRequest: total token usage never exceeds maxRequestTokens * the safety margin', () => {
  const history = [];
  for (let i = 1; i <= 30; i += 1) {
    history.push(makeMessage(i, NOW - (31 - i) * MIN, { content: 'word '.repeat(20) }));
  }
  const config = fakeConfig({ llm: { maxRequestTokens: 500 } });
  const request = buildRequest(baseInput({ history, config }));
  const cap = config.llm.maxRequestTokens * SAFETY_MARGIN;
  assert.ok(request.stats.used <= cap, `used ${request.stats.used} must be <= cap ${cap}`);
});

test('buildRequest: videos reach the transcript', () => {
  const trigger = makeMessage(1, NOW - MIN, {
    attachments: [
      {
        id: 'v1',
        kind: 'video',
        url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4',
        name: 'clip.mp4',
        durationSec: 34,
      },
    ],
  });
  const videos = new Map([['v1', { state: 'watched', text: 'κάποιος χορεύει' }]]);
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', videos }));

  const watched = fill(labels.transcript.videoWatched, { name: 'clip.mp4', duration: '0:34', text: 'κάποιος χορεύει' });
  const primaryText = contentText(request.messages[1].content);
  assert.ok(primaryText.includes(watched));
});

test('buildRequest: idByIndex maps every transcript index to its message id', () => {
  const history = [makeMessage('a', NOW - 3 * MIN), makeMessage('b', NOW - 2 * MIN), makeMessage('c', NOW - MIN)];
  const request = buildRequest(baseInput({ history }));
  assert.equal(request.idByIndex.get(1), 'a');
  assert.equal(request.idByIndex.get(2), 'b');
  assert.equal(request.idByIndex.get(3), 'c');
});

test('prompt: returns the ids of the kept window, the parents and the previewed parts', () => {
  const parent = makeMessage('p1', NOW - 30 * MIN, { content: 'ο παλιός λόγος', replyParent: true });
  const withFile = makeMessage('m2', NOW - 2 * MIN, {
    authorId: 'author-x',
    attachments: [
      { id: 'f1', kind: 'text', url: 'https://cdn/notes.txt', name: 'notes.txt', previewText: 'café crème' },
    ],
  });
  const trigger = makeMessage('m3', NOW - MIN, {
    replyToId: 'p1',
    attachments: [{ id: 'i1', kind: 'image', url: 'img1' }],
  });
  const request = buildRequest(baseInput({ history: [parent, withFile, trigger], trigger, triggerKind: 'reply' }));
  assert.deepEqual(request.seen, {
    messageIds: ['p1', 'm2', 'm3'],
    parents: ['p1'],
    parts: { filePreviews: ['m2'] },
  });

  // Under a tight budget only the kept tail of the window counts as seen; a dropped parent is not listed.
  const history = [makeMessage('p0', NOW - 40 * MIN, { replyParent: true, content: 'word '.repeat(20) })];
  for (let i = 1; i <= 10; i += 1)
    history.push(makeMessage(`n${i}`, NOW - (11 - i) * MIN, { content: 'word '.repeat(20) }));
  const tight = buildRequest(baseInput({ history, config: fakeConfig({ llm: { maxRequestTokens: exactly(400) } }) }));
  assert.ok(tight.stats.chat.dropped > 0, 'the chat is trimmed');
  assert.equal(tight.seen.messageIds.length, tight.stats.chat.kept);
  assert.deepEqual(
    tight.seen.messageIds,
    history.slice(history.length - tight.stats.chat.kept).map((message) => message.id)
  );
  assert.deepEqual(tight.seen.parents, []);
  assert.deepEqual(tight.seen.parts, { filePreviews: [] });
});

test('buildRequest: idByIndex still covers messages later trimmed out of the rendered chat', () => {
  const history = [];
  for (let i = 1; i <= 10; i += 1) {
    history.push(makeMessage(i, NOW - (11 - i) * MIN, { content: 'word '.repeat(20) }));
  }
  // 340 was tight enough before <senses> gained the channels line (part of
  // the always-kept "fixed" section); 400 still trims the chat.
  const config = fakeConfig({ llm: { maxRequestTokens: exactly(400) } });
  const request = buildRequest(baseInput({ history, config }));
  assert.ok(request.stats.chat.dropped > 0, 'the chat is trimmed');
  // idByIndex is built from the FULL transcript, before trimming.
  assert.equal(request.idByIndex.size, 10);
  assert.equal(request.idByIndex.get(1), 1);
});

// --- tempo thresholds come from config, not hardcoded in the renderer -------

// --- <server>: the channel map -----------------------------------------------

test('buildRequest: with no stored note and no channel facts anywhere in history, <server> stays empty', () => {
  const history = [makeMessage(1, NOW - MIN)];
  const request = buildRequest(baseInput({ history, channels: [], currentChannelId: 'c1' }));
  assert.ok(!contentText(request.messages[1].content).includes('<server>'));
});

// --- profileStateFields: the attitude and its moves, in the <people_now> entry -----

test('profileStateFields: relationships off gives no attitude field, even with a non-zero score', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    affinity: { score: 80, reason: 'saved my day', history: [] },
  };
  assert.deepEqual(profileStateFields(profile, labels, { relationships: false, compact: true }), []);
});

test('profileStateFields: relationships on gives the attitude field first; the profile itself never shows it', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    affinity: { score: 80, reason: 'saved my day', history: [] },
  };
  assert.deepEqual(profileStateFields(profile, labels, { relationships: true, compact: true }), [
    `- ${F.attitude}: 80 (devoted) — saved my day`,
  ]);
  assert.equal(renderProfile(profile, labels, { relationships: true }), '## Carl\ncharacter: calm');
});

test('profileStateFields: a neutral score with no reason is the attitude none, with no moves field', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    affinity: { score: 0, reason: '', history: [attitudeMove(1, 2, 'α')] },
  };
  assert.deepEqual(
    fieldsOf(profileStateFields(profile, labels, { relationships: true, shownMoves: 4, compact: true })),
    { [F.attitude]: V.none }
  );
  assert.deepEqual(
    fieldsOf(
      profileStateFields({ id: 'p2', names: ['Dee'] }, labels, { relationships: true, shownMoves: 4, compact: true })
    ),
    { [F.attitude]: V.none },
    'no affinity at all'
  );
});

test('profileStateFields: a zero score with a non-empty reason still gives an attitude', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    affinity: { score: 0, reason: 'used to dislike them, now unsure', history: [] },
  };
  assert.equal(
    fieldsOf(profileStateFields(profile, labels, { relationships: true }))[F.attitude],
    '0 (neutral) — used to dislike them, now unsure'
  );
});

test('renderProfile: a profile whose only content is an attitude is still rendered, by its heading alone', () => {
  const profile = { id: 'p1', names: ['Carl'], affinity: { score: -30, reason: 'annoying', history: [] } };
  assert.equal(renderProfile(profile, labels, { relationships: true, interlocutor: false }), '## Carl');
  assert.equal(
    fieldsOf(profileStateFields(profile, labels, { relationships: true }))[F.attitude],
    '-30 (dislike) — annoying'
  );
  assert.equal(renderProfile(profile, labels, { relationships: false }), '', 'without relationships: nothing to show');
});

test('profileStateFields: a damped (fractional) score is rounded to an integer, the band still uses the precise value', () => {
  // 24.6 rounds to 25 for display, while the band itself is computed on the precise 24.6, which
  // is still "warm" (the "fond" threshold is 25 and up) -- see src/memory/affinity.ts#affinityBand.
  const profile = { id: 'p1', names: ['Carl'], affinity: { score: 24.6, reason: 'saved my day', history: [] } };
  assert.equal(
    fieldsOf(profileStateFields(profile, labels, { relationships: true }))[F.attitude],
    '25 (warm) — saved my day'
  );
});

test('renderProfile: a profile with no affinity at all (pre-relationships data) renders as before', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm' };
  assert.equal(renderProfile(profile, labels, { relationships: true }), '## Carl\ncharacter: calm');
});

/** One stored attitude move on 2026-03-`day` at `hour` UTC. */
function attitudeMove(day: number, delta: number, reason: string, hour = 12) {
  return { ts: new Date(Date.UTC(2026, 2, day, hour)).toISOString(), delta, appliedDelta: delta, score: 0, reason };
}

/** Carl with a score of 40, the attitude's reason `reason` and the given moves. */
function movedProfile(history: Array<unknown>, reason = 'latest reason') {
  return { id: 'p1', names: ['Carl'], character: 'calm', affinity: { score: 40, reason, history } };
}

/** The moves of a profile's state fields, in their order; null without a moves field. */
function movesOf(lines: Array<string>) {
  const value = fieldsOf(lines)[F.moves];
  return value === undefined ? null : value === V.none ? [] : value.split('; ');
}

test('profileStateFields: the moves follow the attitude on their own line, oldest first, signed and dated in the time zone', () => {
  const history = [
    attitudeMove(5, -2, 'mocked <@223456789012345678>'),
    attitudeMove(1, 3, 'linked a game to a myth', 22),
  ];
  const nameOf = (id: string) => (id === '223456789012345678' ? 'Zoë' : null);
  const lines = profileStateFields(movedProfile(history), labels, {
    relationships: true,
    shownMoves: 4,
    timezone: 'Europe/Athens',
    nameOf,
    compact: true,
  });
  assert.deepEqual(
    lines,
    [
      `- ${F.attitude}: 40 (fond) — latest reason`,
      // 22:00 UTC on 03-01 is already 03-02 in Athens.
      `- ${F.moves}: move +3 on 2026-03-02: linked a game to a myth`,
    ],
    'a compact profile: one move'
  );
  const full = profileStateFields(movedProfile(history), labels, {
    relationships: true,
    shownMoves: 4,
    timezone: 'Europe/Athens',
    nameOf,
  });
  assert.deepEqual(movesOf(full), [
    'move +3 on 2026-03-02: linked a game to a myth',
    'move -2 on 2026-03-05: mocked Zoë',
  ]);
  assert.equal(
    renderProfile(movedProfile(history), labels, {
      relationships: true,
      shownMoves: 4,
      timezone: 'Europe/Athens',
      nameOf,
    }),
    '## Carl\ncharacter: calm'
  );
});

test('profileStateFields: shownMoves caps the moves, keeping the strongest', () => {
  const history = [attitudeMove(1, 1, 'α'), attitudeMove(2, 5, 'β'), attitudeMove(3, 2, 'γ'), attitudeMove(4, 4, 'δ')];
  const lines = profileStateFields(movedProfile(history), labels, {
    relationships: true,
    shownMoves: 2,
    timezone: 'UTC',
  });
  assert.deepEqual(movesOf(lines), ['move +5 on 2026-03-02: β', 'move +4 on 2026-03-04: δ']);
});

test('profileStateFields: the moves keep both signs when there are both and the cap allows', () => {
  const history = [
    attitudeMove(1, -1, 'impatient again'),
    attitudeMove(2, 5, 'α'),
    attitudeMove(3, 4, 'β'),
    attitudeMove(4, 3, 'γ'),
  ];
  const lines = profileStateFields(movedProfile(history), labels, {
    relationships: true,
    shownMoves: 2,
    timezone: 'UTC',
  });
  assert.deepEqual(movesOf(lines), ['move -1 on 2026-03-01: impatient again', 'move +5 on 2026-03-02: α']);
});

test('profileStateFields: the move whose reason the attitude shows is not repeated; with no other move the field says none', () => {
  const history = [attitudeMove(1, 2, 'α'), attitudeMove(2, -6, 'latest reason')];
  const lines = profileStateFields(movedProfile(history), labels, {
    relationships: true,
    shownMoves: 4,
    timezone: 'UTC',
  });
  assert.deepEqual(movesOf(lines), ['move +2 on 2026-03-01: α']);
  assert.equal(lines.join('\n').split('latest reason').length, 2, 'the current reason appears once, on the attitude');
  assert.deepEqual(
    movesOf(
      profileStateFields(movedProfile([attitudeMove(2, -6, 'latest reason')]), labels, {
        relationships: true,
        shownMoves: 4,
      })
    ),
    []
  );
});

test('profileStateFields: a move with an empty reason is skipped', () => {
  const history = [attitudeMove(1, 9, ''), attitudeMove(2, 2, 'α')];
  const lines = profileStateFields(movedProfile(history), labels, {
    relationships: true,
    shownMoves: 4,
    timezone: 'UTC',
  });
  assert.deepEqual(movesOf(lines), ['move +2 on 2026-03-02: α']);
});

test('profileStateFields: shownMoves 0 shows no moves field, the attitude stays', () => {
  const lines = profileStateFields(movedProfile([attitudeMove(1, 2, 'α')]), labels, {
    relationships: true,
    shownMoves: 0,
    timezone: 'UTC',
    compact: true,
  });
  assert.deepEqual(lines, [`- ${F.attitude}: 40 (fond) — latest reason`]);
});

test('profileStateFields: relationships off shows no moves', () => {
  const lines = profileStateFields(movedProfile([attitudeMove(1, 2, 'α')]), labels, {
    relationships: false,
    shownMoves: 4,
    timezone: 'UTC',
  });
  assert.equal(movesOf(lines), null);
});

test('profileStateFields: a compact profile shows at most the one strongest move, and no moves field with shownMoves 0', () => {
  const history = [attitudeMove(1, -1, 'β'), attitudeMove(2, 5, 'α'), attitudeMove(3, 2, 'γ')];
  const compact = profileStateFields(movedProfile(history), labels, {
    compact: true,
    relationships: true,
    shownMoves: 4,
    timezone: 'UTC',
  });
  assert.deepEqual(movesOf(compact), ['move +5 on 2026-03-02: α']);
  const none = profileStateFields(movedProfile(history), labels, {
    compact: true,
    relationships: true,
    shownMoves: 0,
    timezone: 'UTC',
  });
  assert.equal(movesOf(none), null);
});

// --- renderProfile: episodes --------------------------------------------------

function episodeFixture(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-01-01',
    what: 'said something memorable',
    quote: 'never forget this',
    feeling: 'touched',
    weight: 3,
    addedAt: 'a',
    ...overrides,
  };
}

test('renderProfile: episodes render only for the interlocutor, right after the heading', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    affinity: { score: 10, reason: 'nice', history: [] },
    episodes: [episodeFixture()],
  };
  const text = renderProfile(profile, labels, { relationships: true, interlocutor: true, episodes: { enabled: true } });
  const lines = text.split('\n');
  assert.equal(lines[0], '## Carl');
  assert.equal(lines[1], labels.profile.episodes);
  assert.equal(lines[2], '2026-01-01: said something memorable — "never forget this" (touched)');
  assert.ok(!text.includes('attitude:'), 'the attitude is in the row');
});

test('renderProfile: opts.handle follows the name on the heading; none without it', () => {
  const profile = { id: 'p1', names: ['Carl', 'OldCarl'], character: 'calm' };
  assert.equal(renderProfile(profile, labels, { handle: 'u1a2b' }).split('\n')[0], '## Carl (@u1a2b)');
  assert.equal(renderProfile(profile, labels, { compact: true, handle: 'u1a2b' }).split('\n')[0], '## Carl (@u1a2b)');
  assert.equal(renderProfile(profile, labels, { handle: null }).split('\n')[0], '## Carl');
});

test('renderProfile: the interlocutor heading is bare: the mark describes the request and lives in <people_now>', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    episodes: [episodeFixture()],
  };
  const options = { relationships: true, interlocutor: true, episodes: { enabled: true } };
  const text = renderProfile(profile, labels, options);
  assert.equal(text.split('\n')[0], '## Carl');
  assert.ok(!text.includes(labels.peopleNow.marks.interlocutor));
  assert.equal(renderProfile(profile, labels, { ...options, mark: false }), text, 'an old mark option changes nothing');
});

test('renderProfile: episodes are never rendered for a non-interlocutor profile without episodes.max', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm', episodes: [episodeFixture()] };
  const text = renderProfile(profile, labels, {
    relationships: true,
    interlocutor: false,
    episodes: { enabled: true },
  });
  assert.ok(!text.includes(labels.profile.episodes));
});

test('renderProfile: episodes.max renders the top episodes of a non-interlocutor right after the heading', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    affinity: { score: 10, reason: 'nice', history: [] },
    episodes: [
      episodeFixture({ what: 'léger', weight: 1, quote: '' }),
      episodeFixture({ what: 'lourd', weight: 5, quote: '' }),
      episodeFixture({ what: 'moyen', weight: 3, quote: '' }),
    ],
  };
  const lines = renderProfile(profile, labels, { relationships: true, episodes: { enabled: true, max: 2 } }).split(
    '\n'
  );
  assert.deepEqual(lines, [
    '## Carl',
    labels.profile.episodes,
    fill(labels.profile.episodeNoQuote, { date: '2026-01-01', what: 'lourd', feeling: 'touched' }),
    fill(labels.profile.episodeNoQuote, { date: '2026-01-01', what: 'moyen', feeling: 'touched' }),
    'character: calm',
  ]);
  for (const max of [0, -2, 1.5, undefined]) {
    const text = renderProfile(profile, labels, { relationships: true, episodes: { enabled: true, max } });
    assert.ok(!text.includes(labels.profile.episodes), String(max));
  }
  assert.ok(
    !renderProfile(profile, labels, { relationships: true, episodes: { enabled: false, max: 2 } }).includes('lourd')
  );
  assert.ok(
    !renderProfile(profile, labels, {
      compact: true,
      relationships: true,
      episodes: { enabled: true, max: 2 },
    }).includes('lourd')
  );
});

test('renderProfile: a non-interlocutor capped below one episode shows no episodes heading', () => {
  const cost = (text: string) => estimateTokens(text) + 2;
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    episodes: [episodeFixture({ what: 'lourd', weight: 5 }), episodeFixture({ what: 'léger', weight: 1 })],
  };
  const bare = renderProfile(profile, labels, {});
  const headingOnly = cost(bare) + cost(labels.profile.episodes);
  assert.equal(renderProfile(profile, labels, { episodes: { enabled: true, max: 2, cap: headingOnly, cost } }), bare);
  const one = renderProfile(profile, labels, { episodes: { enabled: true, max: 2, cap: headingOnly + 1000, cost } });
  assert.ok(one.includes(labels.profile.episodes) && one.includes('lourd'));
  // Nothing else learned and not one episode fits: no profile at all.
  assert.equal(
    renderProfile({ ...profile, character: undefined }, labels, {
      episodes: { enabled: true, max: 2, cap: headingOnly, cost },
    }),
    ''
  );
});

test('renderProfile: episodes.max never caps the interlocutor', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    episodes: [episodeFixture({ what: 'un' }), episodeFixture({ what: 'deux' }), episodeFixture({ what: 'trois' })],
  };
  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true, max: 1 } });
  for (const what of ['un', 'deux', 'trois']) assert.ok(text.includes(`: ${what} —`), what);
});

test('renderProfile: episodes are never rendered when episodes.enabled is false/absent', () => {
  const profile = { id: 'p1', names: ['Carl'], episodes: [episodeFixture()] };
  const text = renderProfile(profile, labels, { relationships: true, interlocutor: true });
  assert.ok(!text.includes(labels.profile.episodes));
});

test('renderProfile: an episode with no quote uses profile.episodeNoQuote', () => {
  const profile = { id: 'p1', names: ['Carl'], episodes: [episodeFixture({ quote: '' })] };
  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true } });
  assert.ok(text.includes('2026-01-01: said something memorable (touched)'));
  assert.ok(!text.includes('"'));
});

test('renderProfile: episodes render heaviest weight first, then newest', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    episodes: [
      episodeFixture({ what: 'light-old', weight: 1, date: '2026-01-01' }),
      episodeFixture({ what: 'heavy', weight: 5, date: '2026-01-01' }),
      episodeFixture({ what: 'light-new', weight: 1, date: '2026-02-01' }),
    ],
  };
  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true } });
  const order = ['heavy', 'light-new', 'light-old'].map((w) => text.indexOf(w));
  assert.ok(order[0] < order[1] && order[1] < order[2]);
});

test('renderProfile: a tight episodes cap drops the lightest episodes first', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    episodes: [
      episodeFixture({ what: 'heaviest', weight: 5, quote: '' }),
      episodeFixture({ what: 'lightest', weight: 1, quote: '' }),
    ],
  };
  const cost = (text: string) => text.length; // a simple, deterministic stand-in for the real token cost
  const restText = renderProfile({ ...profile, episodes: [] }, labels, {
    interlocutor: true,
    episodes: { enabled: true },
  });
  const heading = labels.profile.episodes;
  const heavyLine = fill(labels.profile.episodeNoQuote, { date: '2026-01-01', what: 'heaviest', feeling: 'touched' });
  // Room for the rest of the profile plus exactly the heading and one episode line.
  const cap = cost(restText) + cost(heading) + cost(heavyLine);

  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true, cap, cost } });
  assert.ok(text.includes('heaviest'));
  assert.ok(!text.includes('lightest'));
});

test('renderProfile: an episodes cap too small even for the heading renders no episodes at all', () => {
  const profile = { id: 'p1', names: ['Carl'], episodes: [episodeFixture()] };
  const cost = (text: string) => text.length;
  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true, cap: 1, cost } });
  assert.ok(!text.includes(labels.profile.episodes));
});

// --- renderProfile: interests --------------------------------------------------

function interestFixture(overrides: Record<string, unknown> = {}) {
  return { topic: 'Chess', note: '', weight: 1, firstSeen: 'a', lastSeen: 'a', ...overrides };
}

test('renderProfile: renders interests as "topic (note); topic", heaviest weight first', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [
      interestFixture({ topic: 'Anime', note: 'watches shonen', weight: 2 }),
      interestFixture({ topic: 'Chess', note: '', weight: 5 }),
    ],
  };
  const text = renderProfile(profile, labels);
  assert.ok(text.includes('interests: Chess; Anime (watches shonen)'));
});

test('renderProfile: interests render capped at maxInterests, the heaviest kept', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [
      interestFixture({ topic: 'A', weight: 1 }),
      interestFixture({ topic: 'B', weight: 3 }),
      interestFixture({ topic: 'C', weight: 2 }),
    ],
  };
  const text = renderProfile(profile, labels, { maxInterests: 2 });
  assert.ok(text.includes('interests: B; C'));
  assert.ok(!text.includes('interests: B; C; A'));
});

test('renderProfile: uses labels.profile.interestItem/interestItemNoNote when present', () => {
  const customLabels = {
    ...labels,
    profile: { ...labels.profile, interestItem: '[{topic}: {note}]', interestItemNoNote: '<{topic}>' },
  };
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [
      interestFixture({ topic: 'Chess', note: 'weekly club', weight: 2 }),
      interestFixture({ topic: 'Anime', note: '', weight: 1 }),
    ],
  };
  const text = renderProfile(profile, customLabels);
  assert.ok(text.includes('interests: [Chess: weekly club]; <Anime>'));
});

test('renderProfile: an interest below confirmAfter renders with unsureMark, at/above it does not', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [interestFixture({ topic: 'Chess', weight: 1 }), interestFixture({ topic: 'Anime', weight: 2 })],
  };
  const text = renderProfile(profile, labels, { confirmAfter: 2 });
  assert.ok(text.includes(`Chess${labels.profile.unsureMark}`));
  assert.ok(!text.includes(`Anime${labels.profile.unsureMark}`));
});

test('renderProfile: with interestHalfLifeDays, a much fresher interest outranks an older heavier one and sorts first; the older one still carries staleMark', () => {
  const now = Date.UTC(2026, 8, 21);
  const stale = interestFixture({
    topic: 'Old',
    weight: 5,
    lastSeen: new Date(now - 200 * 24 * 3_600_000).toISOString(),
  });
  const fresh = interestFixture({
    topic: 'New',
    weight: 1,
    lastSeen: new Date(now - 1 * 24 * 3_600_000).toISOString(),
  });
  const profile = { id: 'p1', names: ['Carl'], interests: [stale, fresh] };
  // A 90-day half-life makes the ~199-day recency gap (about 2.2 half-lives, +2.2
  // rank) outweigh the weight gap (log2(5.5) - log2(1.5) =~ 1.88 rank) between
  // the two -- see docs/prompt-contract.md, "More is stored than shown,
  // and rank decays with age". This REPLACES the old "fresh first, then weight
  // desc" sort with pure rank order.
  const text = renderProfile(profile, labels, { staleDays: 90, interestHalfLifeDays: 90, now });
  const interestsLine = text.split('\n').find((l) => l.startsWith('interests:'));
  assert.ok(
    interestsLine!.includes(`New; Old${labels.profile.staleMark}`),
    `decay ranks the fresher one first, the older one still gets staleMark: ${interestsLine}`
  );
});

test('renderProfile: an interest can be both unsure and stale, unsureMark before staleMark', () => {
  const now = Date.UTC(2026, 8, 21);
  const item = interestFixture({
    topic: 'Chess',
    weight: 1,
    lastSeen: new Date(now - 200 * 24 * 3_600_000).toISOString(),
  });
  const profile = { id: 'p1', names: ['Carl'], interests: [item] };
  const text = renderProfile(profile, labels, { confirmAfter: 2, staleDays: 90, now });
  assert.ok(text.includes(`Chess${labels.profile.unsureMark}${labels.profile.staleMark}`));
});

// --- renderProfile: details ----------------------------------------------------

function detailFixture(overrides: Record<string, unknown> = {}) {
  return { id: 1, text: 'Owns a cat', weight: 2, firstSeen: 'a', lastSeen: 'a', ...overrides };
}

test('renderProfile: renders detail items joined by "; "', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    details: [
      detailFixture({ text: 'Owns a cat', weight: 3 }),
      detailFixture({ id: 2, text: 'Plays guitar', weight: 1 }),
    ],
  };
  const text = renderProfile(profile, labels);
  assert.ok(text.includes('details: Owns a cat; Plays guitar'));
});

test('renderProfile: details render capped at maxDetails, the top-ranked kept', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    details: [
      detailFixture({ id: 1, text: 'A', weight: 1 }),
      detailFixture({ id: 2, text: 'B', weight: 3 }),
      detailFixture({ id: 3, text: 'C', weight: 2 }),
    ],
  };
  const text = renderProfile(profile, labels, { maxDetails: 2 });
  assert.ok(text.includes('details: B; C'));
  assert.ok(!text.includes('details: B; C; A'));
});

test('renderProfile: with detailHalfLifeDays, a fresher detail outranks an older heavier one', () => {
  const now = Date.UTC(2026, 8, 21);
  const heavyOld = detailFixture({
    id: 1,
    text: 'Ancient favorite fact',
    weight: 10,
    lastSeen: new Date(now - 5 * 365 * 24 * 3_600_000).toISOString(),
  });
  const lightFresh = detailFixture({ id: 2, text: 'Fresh detail', weight: 1, lastSeen: new Date(now).toISOString() });
  const profile = { id: 'p1', names: ['Carl'], details: [heavyOld, lightFresh] };
  const text = renderProfile(profile, labels, { maxDetails: 1, detailHalfLifeDays: 180 });
  assert.ok(text.includes('details: Fresh detail'));
  assert.ok(!text.includes('Ancient favorite fact'));
});

test('renderProfile: an unconfirmed detail renders with unsureMark, details never get the stale mark', () => {
  const now = Date.UTC(2026, 8, 21);
  const unsure = detailFixture({
    id: 1,
    text: 'Owns a cat',
    weight: 1,
    lastSeen: new Date(now - 200 * 24 * 3_600_000).toISOString(),
  });
  const confirmed = detailFixture({ id: 2, text: 'Plays guitar', weight: 2 });
  const profile = { id: 'p1', names: ['Carl'], details: [unsure, confirmed] };
  const text = renderProfile(profile, labels, { confirmAfter: 2, staleDays: 90, now });
  assert.ok(text.includes(`Owns a cat${labels.profile.unsureMark}`));
  assert.ok(
    !text.includes(`Owns a cat${labels.profile.unsureMark}${labels.profile.staleMark}`),
    'no stale mark for details'
  );
  assert.ok(text.includes('Plays guitar'));
  assert.ok(!text.includes(`Plays guitar${labels.profile.unsureMark}`));
});

// --- <senses> ------------------------------------------------------------

/** The `<senses>` bodies of a request: the stable part's (`stable`) and the tail's (`turn`), '' when absent. */
function sensesHalves(request: Built) {
  const parts = request.messages[1].content.filter((part) => part.type === 'text');
  const bodyIn = (part: Part | undefined) =>
    part ? (/<senses>\n([\s\S]*?)\n<\/senses>/.exec(part.text)?.[1] ?? '') : '';
  return {
    stable: bodyIn(parts.find((part) => part.cacheSegment === 'stable')),
    turn: bodyIn(parts.find((part) => !part.cacheSegment)),
  };
}

/** Every `<senses>` line of a request, the stable half first; null with no block at all. */
function sensesOf(request: Built) {
  const { stable, turn } = sensesHalves(request);
  return [stable, turn].filter(Boolean).join('\n') || null;
}

test('buildRequest: the senses carry the described forms of pictures, GIFs and videos', () => {
  // PR 7d: the descriptions are code, so there are no blind forms and the video line is videoWatch.
  const senses = sensesOf(buildRequest(baseInput()));
  assert.ok(senses!.includes(labels.senses.imageDescribed));
  assert.ok(senses!.includes(labels.senses.gifDescribed));
  assert.ok(senses!.includes(labels.senses.videoWatch));
  assert.ok(!senses!.includes(labels.senses.videoDescribed));
});

// --- <senses>: GIF watching -------------------------------------------------------

/** The GIF line of a request's <senses> block under `config` and `prompts` overrides. */
function gifSenses({
  prompts = {},
  labelsOverride,
}: { prompts?: Record<string, unknown>; labelsOverride?: object } = {}) {
  const config = fakeConfig();
  const promptSet = fakePrompts({ ...(labelsOverride ? { labels: labelsOverride } : {}), ...prompts });
  return sensesOf(buildRequest(baseInput({ config, prompts: promptSet })))!.split('\n');
}

test('buildRequest: GIFs watched (video vision on, a watch prompt) -> senses.gifWatched, never gifDescribed', () => {
  for (const prompts of [
    { 'describe-video': 'V' },
    { 'describe-gif': 'G' },
    { 'describe-video': 'V', 'describe-gif': 'G' },
  ]) {
    const lines = gifSenses({ prompts });
    assert.ok(lines.includes(labels.senses.gifWatched), JSON.stringify(Object.keys(prompts)));
    assert.ok(!lines.includes(labels.senses.gifDescribed));
  }
});

test('buildRequest: GIFs not watched -> senses.gifDescribed', () => {
  const states = [{ prompts: {} }, { prompts: { 'describe-video': '' } }];
  for (const state of states) {
    const lines = gifSenses(state);
    assert.ok(lines.includes(labels.senses.gifDescribed), JSON.stringify(state));
    assert.ok(!lines.includes(labels.senses.gifWatched));
  }
});

// --- <senses>: video watching ---------------------------------------------------

test('buildRequest: the senses carry videoWatch and linksWatch', () => {
  const senses = sensesOf(buildRequest(baseInput()));
  assert.ok(senses!.includes(labels.senses.videoWatch));
  assert.ok(senses!.includes(labels.senses.linksWatch));
  assert.ok(!senses!.includes(labels.senses.videoDescribed));
  assert.ok(!senses!.split('\n').includes(labels.senses.links));
});

// --- <senses>: stickers/Lottie -----------------------------------------------

// Slice 7: the Lottie sentence left the shared senses for the Discord interface's own text.
test('buildRequest: the senses carry stickerDescribed and no Lottie line', () => {
  const request = buildRequest(baseInput());
  const senses = sensesOf(request);
  assert.ok(senses!.includes(labels.senses.stickerDescribed));
  assert.ok(!senses!.includes(labels.senses.lottie));
});

// --- <lore> ------------------------------------------------------------------

function loreEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    title: 'The Great Flood',
    keys: ['flood'],
    text: 'It flooded once.',
    always: false,
    source: 'analyzer',
    weight: 3,
    ...overrides,
  };
}

test('buildRequest: no <lore> block when nothing matches the recent chat', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'completely unrelated chatter' })];
  const request = buildRequest(baseInput({ history, loreEntries: [loreEntry()] }));
  assert.ok(!contentText(request.messages[1].content).includes('<lore>'));
});

test('buildRequest: under a tiny lore cap, only the entries that fit survive', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'flood and fire, the two old stories' })];
  const config = fakeConfig({
    context: { caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1 } },
  });
  const request = buildRequest(
    baseInput({
      history,
      config,
      loreEntries: [
        loreEntry({ id: 'l1', title: 'Flood', keys: ['flood'], text: 'x'.repeat(200) }),
        loreEntry({ id: 'l2', title: 'Fire', keys: ['fire'], text: 'y'.repeat(200) }),
      ],
    })
  );
  assert.equal(request.stats.lore.kept, 0);
});

// --- renderProfile: aliases -----------------------------------------------------

function aliasFixture(overrides: Record<string, unknown> = {}) {
  return { name: 'Ari', weight: 2, firstSeen: 'a', lastSeen: 'a', ...overrides };
}

test('renderProfile: renders aliases through labels.profile.aliases, comma-separated, top-ranked first', () => {
  const profile = {
    id: 'p1',
    names: ['Aria'],
    aliases: [aliasFixture({ name: 'Ar', weight: 1 }), aliasFixture({ name: 'Ari', weight: 5 })],
  };
  const text = renderProfile(profile, labels);
  assert.ok(text.includes('Called: Ari, Ar'));
});

test('renderProfile: an unranked-cap maxAliases shows only the top N', () => {
  const profile = {
    id: 'p1',
    names: ['Aria'],
    aliases: [aliasFixture({ name: 'Ar', weight: 1 }), aliasFixture({ name: 'Ari', weight: 5 })],
  };
  const text = renderProfile(profile, labels, { maxAliases: 1 });
  assert.ok(text.includes('Called: Ari'));
  assert.ok(!text.includes('Called: Ari, Ar'));
});

test('renderProfile: no aliases line when the profile has none, or when labels.profile.aliases is missing', () => {
  const profile = { id: 'p1', names: ['Aria'], character: 'calm' };
  assert.ok(!renderProfile(profile, labels).includes('Called:'));

  const withAliases = { id: 'p1', names: ['Aria'], aliases: [aliasFixture()] };
  const brokenLabels = { ...labels, profile: { ...labels.profile, aliases: undefined } };
  assert.ok(!renderProfile(withAliases, brokenLabels).includes('Called:'));
});

// --- renderProfile: <@id> tokens resolved for the chat model -------------------

test('renderProfile: character/style/relationship resolve <@id> tokens via nameOf', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'gets along with <@223456789012345678>',
    style: 'quotes <@223456789012345678> a lot',
    relationship: 'trusts <@223456789012345678>',
  };
  const text = renderProfile(profile, labels, {
    nameOf: (id: string) => (id === '223456789012345678' ? 'Dana' : null),
  });
  assert.ok(text.includes('character: gets along with Dana'));
  assert.ok(text.includes('style: quotes Dana a lot'));
  assert.ok(text.includes('relationship with you: trusts Dana'));
});

test('renderProfile: an id nameOf cannot resolve renders the bare token', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'knows <@223456789012345678>' };
  const text = renderProfile(profile, labels, { nameOf: () => null });
  assert.ok(text.includes('character: knows <@223456789012345678>'));
});

test('renderProfile: interest note and detail text resolve <@id> tokens via nameOf', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [interestFixture({ topic: 'Chess', note: 'plays with <@223456789012345678>' })],
    details: [detailFixture({ text: 'a gift from <@223456789012345678>' })],
  };
  const text = renderProfile(profile, labels, {
    nameOf: (id: string) => (id === '223456789012345678' ? 'Dana' : null),
  });
  assert.ok(text.includes('Chess (plays with Dana)'));
  assert.ok(text.includes('a gift from Dana'));
});

test('renderProfile: episode "what"/"feeling" resolve <@id> tokens via nameOf', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    episodes: [
      episodeFixture({
        what: 'argued with <@223456789012345678>',
        feeling: 'annoyed at <@223456789012345678>',
        quote: '',
      }),
    ],
  };
  const text = renderProfile(profile, labels, {
    interlocutor: true,
    episodes: { enabled: true },
    nameOf: (id: string) => (id === '223456789012345678' ? 'Dana' : null),
  });
  assert.ok(text.includes('argued with Dana'));
  assert.ok(text.includes('annoyed at Dana'));
});

test('profileStateFields: the affinity reason resolves <@id> tokens via nameOf', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    affinity: { score: 10, reason: 'stood up for <@223456789012345678>', history: [] },
  };
  const lines = profileStateFields(profile, labels, {
    relationships: true,
    nameOf: (id: string) => (id === '223456789012345678' ? 'Dana' : null),
  });
  assert.ok(fieldsOf(lines)[F.attitude].includes('stood up for Dana'));
});

// --- buildRequest: <@id> tokens resolved for the chat model, wired through ------

// --- buildRequest: silent members pulled into <people> by name/alias -----------

test('buildRequest: names/aliases shorter than 3 characters never trigger a pull-in', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'oh no, an ox ran off' })];
  const candidateProfiles = [{ id: 'p9', names: ['Ox'], character: 'stubborn' }];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  assert.ok(!contentText(request.messages[1].content).includes('character: stubborn'));
});

test('buildRequest: a candidate never mentioned in the transcript is not pulled in', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'nothing about anyone else here' })];
  const candidateProfiles = [{ id: 'p9', names: ['Dana'], character: 'sarcastic' }];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  assert.ok(!contentText(request.messages[1].content).includes('## Dana'));
});

// --- renderProfile: compact -------------------------------------------------------

test('renderProfile: compact renders current name, aliases, character and up to 5 bare-topic interests -- nothing else; the attitude is in the row', () => {
  const profile = {
    id: 'p1',
    names: ['Carl', 'OldCarl'],
    aliases: [aliasFixture({ name: 'Carlito', weight: 5 })],
    character: 'calm',
    style: 'terse',
    relationship: 'friendly rival',
    messageCount: 42,
    affinity: { score: 10, reason: 'helped once', history: [] },
    interests: [
      interestFixture({ topic: 'Chess', note: 'weekly club', weight: 6 }),
      interestFixture({ topic: 'Anime', note: '', weight: 5 }),
      interestFixture({ topic: 'Coffee', note: '', weight: 4 }),
      interestFixture({ topic: 'Hiking', note: '', weight: 3 }),
      interestFixture({ topic: 'Chess variants', note: '', weight: 2 }),
      interestFixture({ topic: 'Bonsai', note: '', weight: 1 }),
    ],
    details: [{ id: 'd1', text: 'lives nearby', weight: 3 }],
    episodes: [episodeFixture()],
  };
  const text = renderProfile(profile, labels, { compact: true, relationships: true });
  assert.equal(
    text,
    ['## Carl', 'Called: Carlito', 'character: calm', 'interests: Chess; Anime; Coffee; Hiking; Chess variants'].join(
      '\n'
    )
  );
  assert.deepEqual(
    profileStateFields(profile, labels, { compact: true, relationships: true }),
    [`- ${F.attitude}: 10 (warm) — helped once`],
    'no message count in a compact entry'
  );
});

test('renderProfile: compact omits former names, style, details, relationship, message count and episodes', () => {
  const profile = {
    id: 'p1',
    names: ['Carl', 'OldCarl'],
    character: 'calm',
    style: 'terse',
    relationship: 'friendly rival',
    messageCount: 42,
    interests: [interestFixture({ topic: 'Chess', note: 'weekly club', weight: 6 })],
    details: [{ id: 'd1', text: 'lives nearby', weight: 3 }],
    episodes: [episodeFixture()],
  };
  const text = renderProfile(profile, labels, { compact: true, interlocutor: true, episodes: { enabled: true } });
  assert.ok(!text.includes('formerly known as'));
  assert.ok(!text.includes('style:'));
  assert.ok(!text.includes('details:'));
  assert.ok(!text.includes('relationship with you:'));
  assert.ok(!text.includes('messages you have seen'));
  assert.ok(!text.includes(labels.profile.episodes));
  assert.ok(!text.includes('(weekly club)'), 'compact interests drop the note');
});

test('renderProfile: compact interests cap at 5 regardless of maxInterests', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [
      interestFixture({ topic: 'A', weight: 6 }),
      interestFixture({ topic: 'B', weight: 5 }),
      interestFixture({ topic: 'C', weight: 4 }),
      interestFixture({ topic: 'D', weight: 3 }),
      interestFixture({ topic: 'E', weight: 2 }),
      interestFixture({ topic: 'F', weight: 1 }),
    ],
  };
  const text = renderProfile(profile, labels, { compact: true, maxInterests: 100 });
  assert.ok(text.includes('interests: A; B; C; D; E'));
  assert.ok(!text.includes('F'));
});

// --- buildRequest: <people> priority (a)/(b)/(c) --------------------------------

test('buildRequest: a name of exactly 3 characters must match a WHOLE word, never as a prefix', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'the maximum output is high' })];
  const candidateProfiles = [{ id: 'p9', names: ['Max'], character: 'brief' }];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  const user = contentText(request.messages[1].content);
  assert.ok(!user.includes('## Max'), '"maximum" must not match the 3-character name "Max" as a prefix');
});

// --- the web lookup: <lookup>, read links, senses -----------------------------------

function webConfig(web: { links?: object; search?: object } = {}) {
  const config: ReturnType<typeof fakeConfig> & { web?: object } = fakeConfig();
  config.web = { links: { enabled: true, ...web.links }, quickSearch: { enabled: true, ...web.search } };
  return config;
}

function lookupOf(request: Built) {
  const text = contentText(request.messages[1].content);
  const match = /<lookup>\n([\s\S]*?)\n<\/lookup>/.exec(text);
  return match ? match[1] : null;
}

const LOOKUP = {
  query: 'qui a gagné la finale',
  text: 'Deux sources le confirment (example.com).',
  sources: [
    { title: 'Un', url: 'https://www.example.com/1', site: 'example.com' },
    { title: 'Deux', url: 'https://news.example.org/2', site: 'news.example.org' },
  ],
};

test('buildRequest: no lookup, or an older labels.json without labels.lookup -> no <lookup> block', () => {
  assert.equal(lookupOf(buildRequest(baseInput({ config: webConfig() }))), null);
  const { lookup: _omit, ...older } = labels;
  const request = buildRequest(
    baseInput({ config: webConfig(), lookup: LOOKUP, prompts: fakePrompts({ labels: older }) })
  );
  assert.equal(lookupOf(request), null);
});

// --- the server part of <lookup>: what the search of the server's own history found ----------

test('buildRequest: reads reach the <chat> transcript as linkRead', () => {
  const history = [
    makeMessage(1, NOW - MIN, {
      links: [{ id: '1#e0', kind: 'link', site: 'example.org', title: 'Crêpes', url: 'https://example.org/c' }],
    }),
  ];
  const request = buildRequest(baseInput({ config: webConfig(), history, reads: new Map([['1#e0', 'trois œufs']]) }));
  assert.ok(contentText(request.messages[1].content).includes('[link: example.org — Crêpes] [page read: trois œufs]'));
});

test('buildRequest: the links line stays and linksRead follows it; a search key and the grant -> the search line after that', () => {
  const senses = sensesOf(
    buildRequest(baseInput({ config: webConfig(), searchAvailable: true, toolsGranted: ['web.search'] }))
  )!.split('\n');
  const at = senses.indexOf(labels.senses.linksWatch);
  assert.ok(at !== -1, 'the links line is the same as without the lookup');
  assert.equal(senses[at + 1], labels.senses.linksRead);
  assert.equal(senses[at + 2], labels.senses.searchTool);
  assert.equal(senses[at + 3], labels.senses.files);
});

test('buildRequest: the search line needs searchAvailable and the grant -- no key, no grant or searchAvailable omitted shows no search line', () => {
  for (const [searchAvailable, toolsGranted] of [
    [false, ['web.search']],
    [undefined, ['web.search']],
    [true, []],
  ]) {
    const senses = sensesOf(buildRequest(baseInput({ config: webConfig(), searchAvailable, toolsGranted })))!.split(
      '\n'
    );
    assert.ok(!senses.includes(labels.senses.searchTool));
    assert.ok(senses.includes(labels.senses.linksRead), 'reading links needs no search key');
  }
});

test('buildRequest: search disabled -> no search line even with a key and the grant', () => {
  const noSearch = sensesOf(
    buildRequest(
      baseInput({
        config: webConfig({ search: { enabled: false } }),
        searchAvailable: true,
        toolsGranted: ['web.search'],
      })
    )
  )!.split('\n');
  assert.ok(noSearch.includes(labels.senses.linksRead));
  assert.ok(!noSearch.includes(labels.senses.searchTool));
});

// Slice 7: the request is built on its frame, whose cached `<self>` holds both halves of the senses
// (docs/prompt-contract.md), so the order is read in the one block: the per-turn lines close it.
test('buildRequest: recallAvailable true and the grant -> the recall line leads the per-turn senses, before the drawing line', () => {
  const request = buildRequest(
    baseInput({
      config: webConfig(),
      searchAvailable: true,
      recallAvailable: true,
      drawOn: true,
      toolsGranted: ['web.search', 'memory.search'],
    })
  );
  const lines = sensesOf(request)!.split('\n');
  const at = lines.indexOf(labels.senses.searchTool);
  assert.ok(at !== -1);
  assert.equal(lines[at + 1], labels.senses.files, 'the search line stays among the config lines');
  assert.deepEqual(lines.slice(-2), [labels.senses.recallTool, labels.senses.draw]);
});

test('buildRequest: no recall line unless recallAvailable is true and the grant is there', () => {
  for (const [recallAvailable, toolsGranted] of [
    [false, ['memory.search']],
    [undefined, ['memory.search']],
    [null, ['memory.search']],
    [true, []],
  ]) {
    const senses = sensesOf(
      buildRequest(baseInput({ config: webConfig(), searchAvailable: true, recallAvailable, toolsGranted }))
    )!.split('\n');
    assert.ok(!senses.includes(labels.senses.recallTool), String(recallAvailable));
  }
});

test('buildRequest: a private chat shows the recall line when the turn says recall is available, none otherwise', () => {
  const toolsGranted = ['memory.search'];
  const on = sensesOf(buildRequest(privateScene({ recallAvailable: true, toolsGranted })))!.split('\n');
  assert.ok(on.includes(labels.senses.recallTool));
  const off = sensesOf(buildRequest(privateScene({ recallAvailable: false, toolsGranted })))!.split('\n');
  assert.ok(!off.includes(labels.senses.recallTool));
});

// --- drawing ----------------------------------------------------------------

const DRAW_PROMPTS = {
  draw: 'Drawing for {{name}}.\n\n## Look\n\n{{appearance}}\n\n## Request\n\n{{request}}\n',
  appearance: '{{name}}: short hair, green scarf.',
};

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

test('buildDrawPrompt: fills name and request and blanks appearance for a non-self picture', () => {
  const text = buildDrawPrompt({ prompts: DRAW_PROMPTS, selfName: 'Nept', request: 'a cat on a roof', self: false });
  assert.ok(text.startsWith('Drawing for Nept.'));
  assert.ok(text.endsWith('a cat on a roof'));
  assert.ok(!text.includes('{{appearance}}'));
  assert.ok(!text.includes('green scarf'));
  assert.ok(!text.includes('\n\n\n'), 'the blanked appearance leaves no double blank line');
});

test('buildDrawPrompt: includes the rendered appearance for a self picture', () => {
  const text = buildDrawPrompt({ prompts: DRAW_PROMPTS, selfName: 'Nept', request: 'waving at the café', self: true });
  assert.ok(text.includes('## Look\n\nNept: short hair, green scarf.\n\n## Request'));
  assert.ok(text.endsWith('waving at the café'));
});

// Slice 7: on the frame both halves of the senses sit in the cached `<self>` (docs/prompt-contract.md), so the draw
// line is the last line of the one block rather than a line of the tail.
test('renderSenses: draw line shows when she can draw', () => {
  const lines = sensesOf(buildRequest(baseInput({ drawOn: true })))!.split('\n');
  assert.equal(lines.at(-1), labels.senses.draw);
  assert.ok(lines.includes(labels.senses.files));
});

// PR 7d: the daily picture quota is gone, so the input says only whether she can draw (`drawOn`).
test('renderSenses: draw line is absent without drawOn (no image client wired)', () => {
  assert.ok(!sensesOf(buildRequest(baseInput()))!.includes(labels.senses.draw));
});

// --- private chat (dmChat) ------------------------------------------------

function privateScene(overrides: Record<string, unknown> = {}) {
  const trigger = makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Alice' });
  return baseInput({
    history: [trigger],
    trigger,
    triggerKind: 'private',
    prompts: fakePrompts({ private: 'PRIVATE_TASK for {{name}} with {{author}}' }),
    dmChat: { accountId: 'u1' },
    interlocutor: {
      id: 'u1',
      names: ['Alice'],
      relationship: 'PUBLIC_REL',
      details: [{ id: 1, text: 'PUBLIC_DETAIL', weight: 1 }],
      affinity: { score: 10, reason: 'public reason', history: [] },
    },
    privateProfile: {
      relationship: 'PRIVATE_REL',
      details: [{ id: 1, text: 'PRIVATE_DETAIL', weight: 1 }],
      affinity: { score: 5, reason: 'private reason', history: [] },
    },
    channels: [{ id: 'c1', name: 'general', lastMessageAt: NOW, days: {} }],
    currentChannelId: 'c1',
    neighbors: [{ placeId: 'c1', channelName: 'general', messages: [makeMessage(9, NOW - 5 * MIN)] }],
    ...overrides,
  });
}

test('buildRequest: dmChat appends the filled prompts.private after the mode prompt', () => {
  const user = contentText(buildRequest(privateScene()).messages[1].content);
  const task = user.slice(user.indexOf('<task>'));
  assert.ok(
    task.includes(`Called by Alice, they ${labels.triggers.private}.`),
    '{{trigger}} comes from labels.triggers.private'
  );
  assert.ok(task.includes('PRIVATE_TASK for Nept with Alice'));
  assert.ok(task.indexOf('Called by Alice') < task.indexOf('PRIVATE_TASK'));
});

test('buildRequest: without dmChat prompts.private is never appended', () => {
  const user = contentText(buildRequest(privateScene({ dmChat: null })).messages[1].content);
  assert.ok(!user.includes('PRIVATE_TASK'));
});

test('buildRequest: dmChat with no prompts.private leaves the task as the mode prompt alone', () => {
  const prompts = fakePrompts();
  const user = contentText(buildRequest(privateScene({ prompts })).messages[1].content);
  const task = /<task>\n([\s\S]*?)\n<\/task>/.exec(user)![1];
  assert.equal(task, `Called by Alice, they ${labels.triggers.private}. Answer #1 as Nept. Target: #1.`);
});

test('buildRequest: <senses> carries senses.dmChat in a private chat, never senses.privateAware', () => {
  for (const enabled of [true, false, undefined]) {
    const config = fakeConfig({ dm: { enabled } });
    const senses = sensesOf(buildRequest(privateScene({ config })));
    assert.ok(senses!.includes(labels.senses.dmChat));
    assert.ok(!senses!.includes(labels.senses.privateAware));
  }
});

test('buildRequest: <senses> carries senses.privateAware outside a private chat only when dm.enabled is true', () => {
  const on = sensesOf(buildRequest(baseInput({ config: fakeConfig({ dm: { enabled: true } }) })));
  assert.ok(on!.includes(labels.senses.privateAware));
  assert.ok(!on!.includes(labels.senses.dmChat));
  for (const enabled of [false, undefined, 'yes']) {
    const senses = sensesOf(buildRequest(baseInput({ config: fakeConfig({ dm: { enabled } }) })));
    assert.ok(!senses!.includes(labels.senses.privateAware));
    assert.ok(!senses!.includes(labels.senses.dmChat));
  }
});
const HOUR = 60 * MIN;
const TZ = 'Europe/Moscow';

test('buildRequest: a part of a split message appends labels.task.part with the part and the other parts', () => {
  const trigger = makeMessage(1, NOW - MIN, {
    authorName: 'Alice',
    content: 'ποιος είναι ο Νίκος, κοίτα το κανάλι, και το μιμίδιο',
  });
  const parts = ['ποιος είναι ο Νίκος', 'κοίτα το κανάλι', 'και το μιμίδιο'];
  const task = (overrides: Record<string, unknown>) =>
    bodyOf(
      userText(buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', ...overrides }))),
      'task'
    );
  const plain = task({ tasks: null });
  const others = ['1. ποιος είναι ο Νίκος', '3. και το μιμίδιο'].join('; ');
  const second = { part: { index: 2, total: 3, parts }, queued: [], added: [] };
  assert.equal(
    task({ tasks: second }),
    [plain, fill(labels.task.part, { index: 2, total: 3, part: 'κοίτα το κανάλι', others })].join('\n\n')
  );
  const { task: _task, ...older } = labels;
  assert.equal(
    task({ tasks: second, prompts: fakePrompts({ labels: older }) }),
    plain,
    'an older labels file adds nothing'
  );
  assert.equal(
    task({ tasks: { ...second, part: { index: 4, total: 3, parts } } }),
    plain,
    'a part out of range adds nothing'
  );
});

test("buildRequest: the author's queued calls follow a part's others, numbered on; without a part they get labels.task.queued", () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const parts = ['ένα', 'δύο'];
  const task = (tasks: unknown) =>
    bodyOf(userText(buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', tasks }))), 'task');
  const plain = task(null);
  assert.equal(
    task({ part: { index: 1, total: 2, parts }, queued: ['τρία', 'τέσσερα'], added: [] }),
    [plain, fill(labels.task.part, { index: 1, total: 2, part: 'ένα', others: '2. δύο; 3. τρία; 4. τέσσερα' })].join(
      '\n\n'
    )
  );
  assert.equal(
    task({ part: null, queued: ['τρία', 'τέσσερα'], added: [] }),
    [plain, fill(labels.task.queued, { others: '1. τρία; 2. τέσσερα' })].join('\n\n')
  );
  const { queued: _queued, ...noQueued } = labels.task;
  const older = fakePrompts({ labels: { ...labels, task: noQueued } });
  assert.equal(
    bodyOf(
      userText(
        buildRequest(
          baseInput({
            history: [trigger],
            trigger,
            triggerKind: 'mention',
            prompts: older,
            tasks: { part: null, queued: ['τρία'], added: [] },
          })
        )
      ),
      'task'
    ),
    plain
  );
});

test("buildRequest: other members' waiting calls append labels.task.queuedOthers, on a part too; an older labels file adds nothing", () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const task = (tasks: unknown, prompts = fakePrompts()) =>
    bodyOf(
      userText(buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', tasks, prompts }))),
      'task'
    );
  const plain = task(null);
  const others = [
    { author: 'Léa', text: 'δύο' },
    { author: 'Bjørn', text: 'τρία' },
  ];
  const othersText = fill(labels.task.queuedOthers, { others: '1. Léa: δύο; 2. Bjørn: τρία' });
  assert.equal(
    task({ part: null, queued: ['ένα'], queuedOthers: others, added: ['λοιπόν;'] }),
    [
      plain,
      fill(labels.task.queued, { others: '1. ένα' }),
      othersText,
      fill(labels.task.added, { added: 'λοιπόν;' }),
    ].join('\n\n')
  );
  const part = { index: 1, total: 2, parts: ['α', 'β'] };
  assert.equal(
    task({ part, queued: [], queuedOthers: others, added: [] }),
    [plain, fill(labels.task.part, { index: 1, total: 2, part: 'α', others: '2. β' }), othersText].join('\n\n')
  );
  const { queuedOthers: _others, ...older } = labels.task;
  assert.equal(
    task(
      { part: null, queued: [], queuedOthers: others, added: [] },
      fakePrompts({ labels: { ...labels, task: older } })
    ),
    plain
  );
});

test('buildRequest: messages folded into the call append labels.task.added after the other task labels', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const task = (tasks: unknown, prompts = fakePrompts()) =>
    bodyOf(
      userText(buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', tasks, prompts }))),
      'task'
    );
  const plain = task(null);
  const tasks = { part: null, queued: ['τρία'], added: ['και το δεύτερο;', 'λοιπόν;'] };
  assert.equal(
    task(tasks),
    [
      plain,
      fill(labels.task.queued, { others: '1. τρία' }),
      fill(labels.task.added, { added: 'και το δεύτερο;; λοιπόν;' }),
    ].join('\n\n')
  );
  const { added: _added, ...noAdded } = labels.task;
  assert.equal(
    task({ ...tasks, queued: [] }, fakePrompts({ labels: { ...labels, task: noAdded } })),
    plain,
    'an older labels file adds nothing'
  );
});

test('buildRequest: senses carry the time line right after the files line, in a private chat too', () => {
  const server = sensesOf(buildRequest(baseInput()))!.split('\n');
  assert.equal(server[server.indexOf(labels.senses.files) + 1], labels.senses.time);
  const privateLines = sensesOf(buildRequest(privateScene()))!.split('\n');
  assert.equal(privateLines[privateLines.indexOf(labels.senses.files) + 1], labels.senses.time);
});

test('buildRequest: senses without a time label show no time line', () => {
  const { time, ...olderSenses } = labels.senses;
  const older = sensesOf(
    buildRequest(baseInput({ prompts: fakePrompts({ labels: { ...labels, senses: olderSenses } }) }))
  )!.split('\n');
  assert.ok(!older.includes(time));
  // Slice 7: `senses.channels` is deleted, so a blank time label is checked as no empty line.
  const blank = sensesOf(
    buildRequest(baseInput({ prompts: fakePrompts({ labels: { ...labels, senses: { ...labels.senses, time: '' } } }) }))
  )!.split('\n');
  assert.ok(!blank.includes(time) && !blank.includes(''));
});

test('buildRequest: an old chat line shows one clock and no age, whatever input.now is', () => {
  const history = [makeMessage('old', NOW - 3 * HOUR), makeMessage('new', NOW - 10 * MIN)];
  const config = fakeConfig({ context: { ageAfterMinutes: 30 } });
  const chat = (now: number) => bodyOf(userText(buildRequest(baseInput({ history, config, now }))), 'chat');
  const text = chat(NOW);
  // Slice 2 (b): one clock per line and no age, so the old line reads like the recent one.
  assert.ok(text!.includes(`#1 [${formatClock(NOW - 3 * HOUR, TZ)}] Userold:`), text!);
  assert.ok(text!.includes(`#2 [${formatClock(NOW - 10 * MIN, TZ)}] Usernew:`), text!);
  // The same messages an hour later: the line reads the same, since no age follows the request's clock.
  const later = chat(NOW + 60 * MIN);
  // Slice 2 (b): one clock per line and no age, so a later request clock changes nothing on the line.
  assert.ok(later!.includes(`#1 [${formatClock(NOW - 3 * HOUR, TZ)}] Userold:`), later!);
});

// --- code fallbacks equal config.json --------------------------------------------

// ---- validity: closed claims and conflict sets in <people> ----------------------

test('prompt: a closed claim renders once as before on its successor within supersededShownDays, never alone', () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const day = 24 * 3_600_000;
  const profileAt = (recordedMs: number) => ({
    id: 'p1',
    names: ['Zoé'],
    interests: [
      {
        topic: 'πόκερ',
        note: '',
        weight: 2,
        firstSeen: null,
        lastSeen: null,
        itemId: 'in-b',
        recordedAt: new Date(recordedMs).toISOString(),
      },
      { topic: 'κιθάρα', note: '', weight: 1, firstSeen: null, lastSeen: null, itemId: 'in-c' },
    ],
    closed: [
      {
        kind: 'interest',
        topic: 'σκάκι',
        note: '',
        weight: 3,
        firstSeen: null,
        lastSeen: null,
        itemId: 'in-a',
        validTo: '2026-10-08',
        supersededBy: 'in-b',
      },
      {
        kind: 'interest',
        topic: 'τάβλι',
        note: '',
        weight: 3,
        firstSeen: null,
        lastSeen: null,
        itemId: 'in-z',
        validTo: '2026-10-08',
        supersededBy: 'in-gone',
      },
    ],
  });
  const fresh = renderProfile(profileAt(now - 2 * day), labels, { interlocutor: true, now, supersededShownDays: 7 });
  assert.match(fresh, /πόκερ \(was: σκάκι\)/);
  assert.equal(fresh.split('σκάκι').length - 1, 1, 'once');
  assert.ok(!fresh.includes('τάβλι'), 'a closed claim without a shown successor never renders alone');

  const old = renderProfile(profileAt(now - 8 * day), labels, { interlocutor: true, now, supersededShownDays: 7 });
  assert.ok(!old.includes('σκάκι'), 'past supersededShownDays the old claim is gone');
  assert.match(old, /πόκερ; κιθάρα|κιθάρα; πόκερ/);

  // An item a hand edit left closed inside the ranked list is not shown.
  const handEdited = renderProfile(
    {
      id: 'p1',
      names: ['Zoé'],
      details: [
        { id: 1, text: 'ζει στη Λυών', weight: 2, validTo: '2026-10-01' },
        { id: 2, text: 'ζει στη Νίκαια', weight: 2 },
      ],
    },
    labels,
    { interlocutor: true, now }
  );
  assert.ok(!handEdited.includes('Λυών'));
  assert.ok(handEdited.includes('Νίκαια'));
});

test('prompt: a conflict set renders both claims with dates', () => {
  const profile = {
    id: 'p1',
    names: ['Zoé'],
    details: [
      {
        id: 2,
        text: 'ζει στη Νίκαια',
        weight: 1,
        firstSeen: '2026-09-10T10:00:00.000Z',
        lastSeen: '2026-09-10T10:00:00.000Z',
        itemId: 'dt-b',
        conflictSetId: 'dt-a',
      },
      {
        id: 1,
        text: 'ζει στη Λυών',
        weight: 2,
        firstSeen: '2026-09-01T10:00:00.000Z',
        lastSeen: '2026-09-01T10:00:00.000Z',
        itemId: 'dt-a',
        conflictSetId: 'dt-a',
        validFrom: '2026-08-30',
      },
      { id: 3, text: 'έχει γάτα', weight: 1, firstSeen: null, lastSeen: null },
    ],
  };
  const text = renderProfile(profile, labels, { interlocutor: true, now: Date.UTC(2026, 9, 10) });
  assert.match(text, /ζει στη Λυών \/ ζει στη Νίκαια \((conflicting, 2026-08-30 and 2026-09-10)\)/);
  assert.equal(text.split('Νίκαια').length - 1, 1, 'never collapsed, never twice');
  assert.ok(text.includes('έχει γάτα'));
});

// ---- the persona's recent time away, inside <now> ----

// Slice 7: every request is built on its frame, where `<now>` folds into `<spatial_awareness>` (the lead's decision 6):
// the present moment is its first line and her recent time away follows it.
function nowBlockOf(request: Built) {
  const user = contentText(request.messages[1].content);
  const match = /<spatial_awareness>\n([\s\S]*?)\n<\/spatial_awareness>/.exec(user);
  return match ? match[1] : null;
}

/** `{from}` / `{to}` as the request writes a moment: the date and the clock in the bot's zone. */
const momentOf = (ts: number) => `${formatDate(ts, 'Europe/Moscow')}, ${formatClock(ts, 'Europe/Moscow')}`;

test('buildRequest: an owner pause 10:00-10:20 is one line under the lead inside <spatial_awareness>, in the tail', () => {
  const from = NOW - 2 * 60 * MIN;
  const to = from + 20 * MIN;
  const request = buildRequest(baseInput({ offPeriods: [{ kind: 'paused', from, to }] }));
  const lines = nowBlockOf(request)!.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], labels.journal.offLead);
  assert.equal(
    lines[2],
    fill(labels.journal.offPaused, {
      from: momentOf(from),
      to: momentOf(to),
      length: formatDuration(20 * MIN, labels.units),
    })
  );
  assert.ok(lines[2].includes('20 '));
  // Per-turn: never inside a cached part of the user message.
  const parts = request.messages[1].content.filter((part) => part.type === 'text');
  const holder = parts.find((part) => part.text.includes(labels.journal.offLead));
  assert.equal(holder!.cacheSegment, undefined);
});

test('buildRequest: a stopped period reads offStopped; none leaves <spatial_awareness> with the moment alone', () => {
  const from = NOW - 3 * 60 * MIN;
  const to = from + 5 * MIN;
  const stopped = nowBlockOf(buildRequest(baseInput({ offPeriods: [{ kind: 'stopped', from, to }] })));
  assert.ok(
    stopped!.endsWith(
      fill(labels.journal.offStopped, {
        from: momentOf(from),
        to: momentOf(to),
        length: formatDuration(5 * MIN, labels.units),
      })
    )
  );
  const bare = nowBlockOf(buildRequest(baseInput()));
  assert.equal(bare!.split('\n').length, 1);
  assert.equal(nowBlockOf(buildRequest(baseInput({ offPeriods: [] }))), bare);
});

// --- renderProfile: the names people use and the real name -------------------------

test('renderProfile: addressedAs renders most used first (top 5, no numbers), then the aliases not listed yet', () => {
  const NOW = Date.UTC(2026, 9, 1, 12);
  const iso = (ms: number) => new Date(ms).toISOString();
  const profile = {
    id: 'p1',
    names: ['Aria'],
    aliases: [aliasFixture({ name: 'Ari', weight: 5 }), aliasFixture({ name: 'Rì', weight: 1 })],
    addressedAs: {
      // 8 uses 60 days ago are worth 2 now: below the 3 recent ones.
      Aria: { score: 8, last: iso(NOW - 60 * 86_400_000) },
      ari: { score: 3, last: iso(NOW) },
      Ἀρία: { score: 1, last: iso(NOW) },
      Lia: { score: 0.9, last: iso(NOW) },
      Ria: { score: 0.8, last: iso(NOW) },
      Ira: { score: 0.1, last: iso(NOW) },
    },
  };
  const text = renderProfile(profile, labels, { now: NOW, addressHalfLifeDays: 30 });
  assert.ok(text.includes('Called most often: ari, Aria, Ἀρία, Lia, Ria\n'), text);
  assert.ok(!text.includes('Ira'), 'only the top 5');
  assert.ok(text.includes('Called: Rì'), 'the stored alias not already listed');
  assert.ok(!text.includes('Called: Ari'), text);
});

test('renderProfile: without addressedAs the aliases line is as before; a realName gets its own line', () => {
  const profile = {
    id: 'p1',
    names: ['Aria'],
    aliases: [aliasFixture({ name: 'Ari', weight: 5 })],
    realName: { name: 'Théa', from: '2026-01-01', to: null, itemId: 'rn-2' },
  };
  const text = renderProfile(profile, labels);
  assert.ok(text.includes('Called: Ari'));
  assert.ok(!text.includes('Called most often'));
  assert.ok(text.includes('Real name: Théa'));
  const compact = renderProfile(profile, labels, { compact: true });
  assert.ok(compact.includes('Real name: Théa'), 'a compact profile shows it too');
});

test('renderProfile: a freshly replaced real name rides on the new one through labels.profile.before', () => {
  const NOW = Date.UTC(2026, 9, 1, 12);
  const profile = {
    id: 'p1',
    names: ['Aria'],
    realName: {
      name: 'Théa',
      from: '2026-09-30',
      to: null,
      itemId: 'rn-2',
      recordedAt: new Date(NOW - 86_400_000).toISOString(),
    },
    closed: [
      {
        kind: 'realName',
        name: 'Léa',
        validFrom: '2026-01-01',
        validTo: '2026-09-30',
        supersededBy: 'rn-2',
        itemId: 'rn-1',
      },
    ],
  };
  assert.ok(renderProfile(profile, labels, { now: NOW }).includes('Real name: Théa (was: Léa)'));
  const later = renderProfile(profile, labels, { now: NOW + 30 * 86_400_000 });
  assert.ok(
    later.includes('Real name: Théa') && !later.includes('(was: Léa)'),
    'past supersededShownDays the old name is not shown'
  );
});

// --- the cached profiles part: the interlocutor alone ------------------------------------

// --- skills discovery: the static protocol, the catalogue on request -------------------------

/** Catalogue rows as src/tools/gateway.ts#listSkills gives them. */
const SKILL_ROWS = [
  { name: 'message.create', title: 'Στείλε', whenToUse: 'σε άλλη συζήτηση', allowed: true, reason: 'carried-over' },
  { name: 'lore.list', title: '', whenToUse: '', allowed: true, reason: 'allowed' },
  { name: 'message.edit', title: 'Διόρθωσε', whenToUse: 'ένα δικό σου μήνυμα', allowed: true, reason: 'allowed' },
  {
    name: 'memory.profile.read',
    title: 'Θυμήσου',
    whenToUse: 'τις σημειώσεις σου',
    allowed: false,
    reason: 'not-allowed',
  },
  { name: 'memory.wipe', title: 'Σβήσε', whenToUse: 'ποτέ', allowed: false, reason: 'not-grantable' },
];

test('buildRequest: tool_catalogue -- the catalogue never touches the stable part, whatever the grants; her tools are no block of the native transport', () => {
  const plain = buildRequest(segmentScene()).messages[1].content;
  const shown = buildRequest(segmentScene({ skillsInventory: SKILL_ROWS })).messages[1].content;
  const regranted = buildRequest(
    segmentScene({ skillsInventory: SKILL_ROWS.map((row) => ({ ...row, allowed: true, reason: 'allowed' })) })
  ).messages[1].content;
  assert.equal(plain[0].cacheSegment, 'stable');
  assert.equal(shown[0].text, plain[0].text, 'the catalogue never touches the stable part');
  assert.equal(regranted[0].text, plain[0].text, 'a grant never touches the stable part');
  assert.ok(
    !plain[0].text.includes('message.create') && !shown[0].text.includes('message.create'),
    'no skill row in the stable part'
  );
  assert.equal(blockTags(contentText(plain)).includes('tool_catalogue'), false, 'no catalogue without the question');
  assert.equal(blockTags(plain[0].text).includes('tools'), false, 'no <tools> without the text transport');
});

test('buildRequest: skills -- the text transport puts her tools in <tools> in the stable part, fixed and never cut', () => {
  const tools = ['lead', '{"name":"draw.create"}', 'protocol'].join('\n');
  const stable = buildRequest(segmentScene({ toolsBlock: tools })).messages[1].content[0];
  assert.equal(stable.cacheSegment, 'stable');
  // Slice 7: on the frame the stable part opens with `<self>`, which holds `<senses>` and then `<tools>`.
  const self = /^<self>\n([\s\S]*?)\n<\/self>/.exec(stable.text)?.[1] ?? '';
  assert.deepEqual(blockTags(self).slice(0, 2), ['senses', 'tools']);
  assert.equal(blocksOf(self).find((b) => b.tag === 'tools')!.body, tools);
  const bare = buildRequest(segmentScene({ toolsBlock: '' })).messages[1].content[0].text;
  assert.equal(blockTags(bare).includes('tools'), false);
});

test('buildRequest: skills -- the <tools> block keeps the stable part byte-identical whatever the tail holds, and it moves only with the block itself', () => {
  const tools = ['lead', '{"name":"draw.create"}', 'protocol'].join('\n');
  const base = buildRequest(segmentScene({ toolsBlock: tools })).messages[1].content[0].text;
  assert.equal(
    buildRequest(segmentScene({ toolsBlock: tools, skillsInventory: SKILL_ROWS })).messages[1].content[0].text,
    base,
    'the catalogue is in the tail'
  );
  assert.equal(buildRequest(segmentScene({ toolsBlock: tools, toolsTokens: 0 })).messages[1].content[0].text, base);
  const changed = buildRequest(segmentScene({ toolsBlock: `${tools}\n{"name":"web.search"}` })).messages[1].content[0]
    .text;
  assert.notEqual(changed, base);
  assert.equal(changed.replace('\n{"name":"web.search"}', ''), base, 'only the block differs');
});

test('buildRequest: skills -- the tools field of the request takes its tokens off the room the sections share', () => {
  const free = buildRequest(segmentScene());
  const taken = buildRequest(segmentScene({ toolsTokens: 5000 }));
  assert.equal(taken.stats.limit, free.stats.limit - 5000);
});

// --- the skills granted to her, always listed in the stable part ------------------------------

test("skillsInventoryText: each line lists the skill's arguments -- required marked, enum values with the cut shown, a range -- in a stable order", () => {
  const argLabels = {
    ...labels,
    tools: {
      ...labels.tools,
      line: '{name}: {title} -- {whenToUse} ({access}){args}',
      args: { list: ' args: {list}', required: '{arg}*', values: '{arg}={values}', range: '{arg}={min}..{max}' },
    },
  };
  const rows = [
    {
      name: 'memory.journal.read',
      title: 'Διάβασε',
      whenToUse: 'το ημερολόγιο',
      allowed: true,
      reason: 'allowed',
      args: [
        { name: 'day', required: false },
        { name: 'kind', required: false, values: ['turn', 'action'], more: true },
        { name: 'n', required: false, minimum: 1, maximum: 50 },
      ],
    },
    {
      name: 'message.create',
      title: 'Στείλε',
      whenToUse: 'σε άλλη συζήτηση',
      allowed: true,
      reason: 'carried-over',
      args: [
        { name: 'channel', required: false },
        { name: 'text', required: true },
      ],
    },
    {
      name: 'memory.server.read',
      title: 'Θυμήσου',
      whenToUse: 'τον server',
      allowed: true,
      reason: 'allowed',
      args: [],
    },
    {
      name: 'learning.remove',
      title: 'Ξέχνα',
      whenToUse: 'ένα μάθημα',
      allowed: true,
      reason: 'allowed',
      args: [
        { name: 'number', required: true, minimum: 1 },
        { name: 'detail', required: false, values: ['true', 'false'] },
      ],
    },
    {
      name: 'memory.wipe',
      title: 'Σβήσε',
      whenToUse: 'ποτέ',
      allowed: false,
      reason: 'not-grantable',
      args: [{ name: 'confirm', required: true }],
    },
  ];
  const text = skillsInventoryText(rows, argLabels);
  assert.deepEqual(text.split('\n'), [
    'memory.journal.read: Διάβασε -- το ημερολόγιο (allowed) args: day, kind=turn|action|…, n=1..50',
    'memory.server.read: Θυμήσου -- τον server (allowed)',
    '',
    'message.create: Στείλε -- σε άλλη συζήτηση (allowed here) args: channel, text*',
    '',
    'learning.remove: Ξέχνα -- ένα μάθημα (allowed) args: number=1..*, detail=true|false',
  ]);
  assert.equal(skillsInventoryText(rows, argLabels), text, 'the same rows, the same text');
  // Without the args labels the slot is empty; a missing form leaves the bare name.
  const bare = skillsInventoryText(rows.slice(0, 1), {
    ...argLabels,
    tools: { ...argLabels.tools, args: undefined },
  });
  assert.equal(bare, 'memory.journal.read: Διάβασε -- το ημερολόγιο (allowed)');
  const listOnly = skillsInventoryText(rows.slice(0, 2), {
    ...argLabels,
    tools: { ...argLabels.tools, args: { list: ' args: {list}' } },
  });
  assert.deepEqual(listOnly.split('\n'), [
    'memory.journal.read: Διάβασε -- το ημερολόγιο (allowed) args: day, kind, n',
    '',
    'message.create: Στείλε -- σε άλλη συζήτηση (allowed here) args: channel, text',
  ]);
  // A row without args (an older caller) renders as before.
  assert.equal(
    skillsInventoryText([{ ...rows[0], args: undefined }], argLabels),
    'memory.journal.read: Διάβασε -- το ημερολόγιο (allowed)'
  );
});
