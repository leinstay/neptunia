// Tests for src/turn/request/wake.ts: the previous think a request carries, and the wake lines of an inner turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userText as contentText } from '../../../../src/behavior/prompt.ts';
import { labels } from '../../../fixtures/labels.ts';
import type { labels as contractLabels } from '../../../fixtures/labels.ts';
import { buildRequest } from '../../../fixtures/built-request.ts';
import { frameOfInput, framed } from '../../../fixtures/prompt-rig.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowflakeUtil } from 'discord.js';
import { joinLabels } from '../../../../src/config/labels.ts';
import { deepMerge } from '../../../../src/config.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDay } from '../../../../src/time.ts';
import { normalizeMessage } from '../../../../interfaces/discord/index.ts';
import { useIface, useSelf } from '../../../fixtures/turn-world.ts';
import { withTextPreviews } from '../../../../src/media/text-preview.ts';
import { createCalibrator } from '../../../../src/llm/tokens.ts';
import { awakeLines } from '../../../../src/behavior/wake.ts';
import { frameOf } from '../../../../src/turn/request/frame.ts';
import { chainsOf } from '../../../fixtures/chains.ts';

useIface('fake');
useSelf('900000000000000001');

const MIN = 60_000;

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

// --- the block in a request ------------------------------------------------

const NOW = T0;

function requestWith(
  previousThink: {
    text: string;
    ageMs?: number;
    earlier?: ReadonlyArray<{ text: string; ageMs: number }>;
  } | null,
  labelSet: object = labels
) {
  const trigger = {
    id: 'm1',
    ts: NOW - MIN,
    authorId: 'a1',
    authorName: 'Nikos',
    self: false,
    content: 'ping',
    attachments: [],
    stickers: [],
    replyToId: null,
  };
  const input = {
    config: {
      bot: { timezone: 'UTC' },
      context: {
        gapMarkerMinutes: 20,
        maxMessageChars: 800,
        ageAfterMinutes: 60,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
        vision: { maxImages: 0, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
        tempo: { liveMessages10min: 4, deadSilenceMinutes: 45 },
      },
      features: {},
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      memory: {},
    },
    prompts: {
      main: 'SYSTEM',
      persona: 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      'turn/reply': 'Called by {{author}}.',
      interject: 'I',
      initiate: 'N',
      labels: labelSet,
    },
    calibrator: { ratio: 1, apply: (n: number) => n },
    mode: 'reply',
    now: NOW,
    selfName: 'Zoë',
    history: [trigger],
    neighbors: [],
    trigger,
    triggerKind: 'mention',
    placeMemory: {},
    interlocutor: null,
    otherProfiles: [],
    channels: [{ id: 'c1', name: 'general' }],
    currentChannelId: 'c1',
    previousThink,
  };
  // Every request is built on its turn frame (slice 7).
  return buildRequest({ ...input, frame: frameOfInput(input) });
}

test('buildRequest: no block without a think, or without its labels', () => {
  assert.ok(!contentText(requestWith(null).messages[1].content).includes('previous_think'));
  assert.ok(!contentText(requestWith({ text: '  ' }).messages[1].content).includes('previous_think'));
  const bare = { ...labels, previousThink: undefined };
  assert.ok(!contentText(requestWith({ text: 'x' }, bare).messages[1].content).includes('previous_think'));
});

test('buildRequest: three carried thinks print the note once and each think oldest first under its age; one think keeps its bytes', () => {
  // Bug: the block repeats the note per think, lists the newest first or drops the older ones; or an empty
  // `earlier` changes the bytes of the one-think block and breaks the identity replay at the default of 1.
  const blockOf = (previousThink: Parameters<typeof requestWith>[0]) =>
    /<previous_think>\n([\s\S]*?)\n<\/previous_think>/.exec(
      contentText(requestWith(previousThink).messages[1].content)
    )?.[1];
  const three = blockOf({
    text: 'promised a list',
    ageMs: 3 * MIN,
    earlier: [
      { text: 'counted the jars', ageMs: 25 * MIN },
      { text: 'asked about the lids', ageMs: 12 * MIN },
    ],
  });
  assert.equal(
    three,
    [
      labels.previousThink.note,
      '(an earlier turn here, 25 min ago)',
      'counted the jars',
      '(an earlier turn here, 12 min ago)',
      'asked about the lids',
      '(an earlier turn here, 3 min ago)',
      'promised a list',
    ].join('\n')
  );
  const one = { text: 'promised a list', ageMs: 3 * MIN };
  assert.equal(
    blockOf({ ...one, earlier: [] }),
    [labels.previousThink.note, '(an earlier turn here, 3 min ago)', 'promised a list'].join('\n')
  );
  assert.equal(
    contentText(requestWith({ ...one, earlier: [] }).messages[1].content),
    contentText(requestWith(one).messages[1].content)
  );
});

/** The fixed words of a label before its first placeholder. */
const labelHead = (label: string) => label.split('{')[0];

// The chats of the turns, the pipeline and the classifiers are held by a fake interface named `fake`, the
// persona being `SELF_ID`; the recall runner keeps reading the platform's own objects through the recall bridge.

// ---- the shipped layer --------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');

/** The tracked prompt files at any depth, by key: the path relative to prompts/ without `.md`, `/` between the parts. */
const PROMPT_FILES = fs
  .readdirSync(PROMPTS_DIR, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -'.md'.length).split(path.sep).join('/'))
  .sort();

const BOM = String.fromCharCode(0xfeff);

/** `prompts/<name>.md` as src/hot.ts reads it: the BOM and carriage returns dropped, trimmed. */
function readPrompt(name: string) {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, '\n').trim();
}

/** The tracked layer alone: config/ with the labels read joined, and prompts/, never a local override. */
const SHIPPED = {
  config: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: joinLabels(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'labels.json'), 'utf8'))),
  },
};

// The shipped labels carry the keys of the contract (the fixture covers every one).
const LABELS = SHIPPED.prompts.labels as typeof contractLabels;

/**
 * A prompt that carries `{{` or a `{key}` as text on purpose: its file name -> `{ literal, why }`.
 * The literal may remain in a request; anything else in braces may not. None today.
 */
const LITERAL_BRACES: Record<string, { literal: string; why: string }> = {};

/** `text` without the literals of LITERAL_BRACES. */
function withoutLiterals(text: string) {
  let rest = text;
  for (const { literal } of Object.values(LITERAL_BRACES)) rest = rest.split(literal).join('');
  return rest;
}

// The rules prompt reaches a request only while the memory table `rules` holds a rule (src/rules-list.ts). The requests
// here are built with no memory, the way a deployment starts, so it stays in NOT_BUILT: putting it in SYSTEM would mean
// a rule in every fixture, and tests/src/rules-list.test.ts already checks the block with and without one.
const SYSTEM = ['main', 'persona', 'format'];

/** Every kind of diary entry and the prompt file of its own task, which follows the common `diary/task.md`. */
const DIARY_KIND_FILES: Record<string, string> = Object.fromEntries(
  ['story', 'selfPicture', 'picture', 'photoset', 'randomSet', 'news', 'facts', 'thought', 'people', 'meme'].map(
    (kind) => [kind, `diary/kinds/${kind}`]
  )
);

/** The prompt files each request below must carry whole, by request. */
const LOADS = {
  reply: [...SYSTEM, 'turn/reply'],
  followUp: [...SYSTEM, 'turn/follow'],
  overheard: [...SYSTEM, 'turn/overheard'],
  errandResult: [...SYSTEM, 'turn/errand'],
  private: [...SYSTEM, 'turn/reply', 'turn/private'],
  draw: ['draw', 'appearance'],
  ...Object.fromEntries(
    Object.entries(DIARY_KIND_FILES).map(([kind, file]) => [`diary ${kind}`, [...SYSTEM, 'diary/task', file]])
  ),
  inner: [...SYSTEM, 'turn/inner'],
  heartbeat: [...SYSTEM, 'heartbeat/task'],
  describe: ['describe/picture'],
  avatar: ['describe/avatar'],
  describeGif: ['describe/gif'],
  describeVideo: ['describe/video'],
  rewatchAnswer: ['describe/rewatch'],
  searchSummary: ['summarize/search'],
  split: ['classify/split'],
  merge: ['classify/merge'],
  missed: ['classify/missed'],
  mediaPick: ['classify/pick'],
  humanizer: ['humanizer/linter', 'humanizer/editor'],
  turn: [...SYSTEM, 'turn/reply'],
};

/** The shipped config.json with `overrides` deep-merged over a fresh copy. */
function shippedConfig(overrides: Record<string, unknown> = {}) {
  const on = {
    models: { routes: chainsOf({ vision: 'x/vision', video: 'x/video', drawing: 'x/drawing', speech: 'x/speech' }) },
  }; // off when shipped
  return deepMerge(deepMerge(structuredClone(SHIPPED.config), on), overrides);
}

// ---- the checks -----------------------------------------------------------------

/** The text of one message content: a string as is, an array of parts as its text parts. */
function shippedContentText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Every text a request carries, as one string. */
function requestText(messages: Array<{ content: unknown }>) {
  return messages.map((message) => shippedContentText(message.content)).join('\n\n');
}

/** The double-brace sequences left in `text`, LITERAL_BRACES aside. */
function strayPlaceholders(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{\{[^{}\n]{0,40}\}\}|\{\{/g) ?? [])];
}

/** The single-brace `{key}` label placeholders left in `text`, LITERAL_BRACES aside. */
function strayLabelKeys(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{[A-Za-z_]\w*\}/g) ?? [])];
}

/** The lines of prompt `name` without a placeholder: a request that loads the file carries each one verbatim. */
function literalLines(name: string) {
  const text = (SHIPPED.prompts as Record<string, unknown>)[name] as string;
  assert.equal(typeof text, 'string', `prompts/${name}.md is not loaded`);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('{{'));
}

/**
 * Asserts one built request: no `{{placeholder}}` and no label `{key}` left, every prompt file of
 * `files` carried whole, every block of `blocks` rendered. Returns the request's text.
 */
function assertFilled(
  messages: unknown,
  { files = [], blocks = [] }: { files?: Array<string>; blocks?: Array<string> },
  where: string
) {
  assert.ok(Array.isArray(messages) && messages.length > 0, `${where}: no request was built`);
  const text = requestText(messages);
  assert.deepEqual(strayPlaceholders(text), [], `${where}: a placeholder reached the request unfilled`);
  assert.deepEqual(strayLabelKeys(text), [], `${where}: a label placeholder reached the request unfilled`);
  for (const name of files) {
    const missing = literalLines(name).filter((line) => !text.includes(line));
    assert.equal(
      missing.length,
      0,
      `${where}: prompts/${name}.md is not carried whole, e.g. ${JSON.stringify(missing.slice(0, 2))}`
    );
  }
  for (const tag of blocks) {
    if (tag === 'tempo') {
      // Slice 2 (g): `<tempo>` is the foot of `<chat>`, not a block, so its verdict line ends the chat's body.
      const chat = /<chat>\n([\s\S]*?)\n<\/chat>/.exec(text)?.[1] ?? '';
      const verdict = labelHead(LABELS.tempo.verdict);
      assert.ok(chat.split('\n').at(-1)?.startsWith(verdict), `${where}: no tempo at the foot of <chat>`);
      continue;
    }
    assert.ok(text.includes(`<${tag}>\n`), `${where}: no <${tag}> block`);
  }
  return text;
}

// ---- the scene: one server, its members and channels --------------------------------

const SHIPPED_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

const SELF_ID = '900000000000000001';

const SELF_NAME = 'Zoë';

const ANA = '411111111111111111';

const NIKOS = '422222222222222222';

const BJORN = '433333333333333333';

const ELODIE = '444444444444444444';

const GENERAL = '700000000000000001';

const GARDEN = '700000000000000002';

const DIARY = '700000000000000003';

const CHANNEL_INCREMENT: Record<string, bigint> = { [GENERAL]: 1n, [GARDEN]: 2n, [DIARY]: 3n };

const PEOPLE = {
  [ANA]: { id: ANA, name: 'Ana' },
  [NIKOS]: { id: NIKOS, name: 'Nikos' },
  [BJORN]: { id: BJORN, name: 'Björn' },
  [SELF_ID]: { id: SELF_ID, name: SELF_NAME },
};

const iso = (ms: number) => new Date(ms).toISOString();

/** A stored member profile, every field the renderers read filled. */
function profile(id: string, names: Array<string>, extra: Record<string, unknown> = {}) {
  return {
    id,
    names,
    character: `${names[0]} is curious and warm`,
    style: 'short lines, many questions',
    interests: [
      {
        topic: 'gardening',
        note: 'grows tomatoes on a balcony',
        weight: 4,
        firstSeen: iso(SHIPPED_NOW - 30 * DAY_MS),
        lastSeen: iso(SHIPPED_NOW - DAY_MS),
      },
      {
        topic: 'chess',
        note: '',
        weight: 1,
        firstSeen: iso(SHIPPED_NOW - 200 * DAY_MS),
        lastSeen: iso(SHIPPED_NOW - 200 * DAY_MS),
      },
    ],
    details: [
      {
        id: 1,
        text: 'lives near the sea',
        weight: 3,
        firstSeen: iso(SHIPPED_NOW - 40 * DAY_MS),
        lastSeen: iso(SHIPPED_NOW - 2 * DAY_MS),
      },
    ],
    aliases: [
      {
        name: `${names[0].slice(0, 3)}ou`,
        weight: 3,
        firstSeen: iso(SHIPPED_NOW - 20 * DAY_MS),
        lastSeen: iso(SHIPPED_NOW - DAY_MS),
      },
    ],
    relationship: 'an old friend of the chat',
    relationshipScore: 20,
    relationshipWrittenAt: iso(SHIPPED_NOW - 10 * DAY_MS),
    affinity: {
      score: 22,
      reason: 'brought crêpes to the meetup',
      history: [{ delta: 5, ts: SHIPPED_NOW - 3 * DAY_MS }],
    },
    episodes: [
      {
        date: '2026-09-28',
        what: 'taught the persona a card trick',
        quote: 'regarde bien',
        feeling: 'delighted',
        weight: 3,
        addedAt: iso(SHIPPED_NOW - 7 * DAY_MS),
      },
      {
        date: '2026-10-04',
        what: 'asked about the weather',
        quote: '',
        feeling: 'calm',
        weight: 1,
        addedAt: iso(SHIPPED_NOW - DAY_MS),
      },
    ],
    messageCount: 420,
    firstSeen: iso(SHIPPED_NOW - 90 * DAY_MS),
    lastSeen: iso(SHIPPED_NOW - 2 * MINUTE_MS),
    ...extra,
  };
}

const PROFILES: Record<string, ReturnType<typeof profile>> = {
  [ANA]: profile(ANA, ['Ana', 'Anaïs']),
  [NIKOS]: profile(NIKOS, ['Nikos']),
  [BJORN]: profile(BJORN, ['Björn']),
  [ELODIE]: profile(ELODIE, ['Élodie']),
};

const nameOf = (id: string) => {
  const names = PROFILES[id]?.names;
  return names?.[0] ?? null;
};

const GUILD_MEMORY = {
  patterns: 'quick banter, many emoji',
  starters: 'a photo of lunch, a question to the room',
  injokes: ['the eternal tomato'],
  self: ['once claimed to like rain'],
  learned: [
    {
      id: 1,
      text: 'say bonjour before anything else',
      from: `<@${ANA}>`,
      weight: 3,
      firstSeen: iso(SHIPPED_NOW - 9 * DAY_MS),
      lastSeen: iso(SHIPPED_NOW - DAY_MS),
    },
    {
      id: 2,
      text: 'never spoil a film',
      weight: 1,
      firstSeen: iso(SHIPPED_NOW - DAY_MS),
      lastSeen: iso(SHIPPED_NOW - DAY_MS),
    },
  ],
  emojiUsage: { E1: { name: 'zoe_wave', count: 4, last: SHIPPED_NOW - DAY_MS } },
  updatedAt: iso(SHIPPED_NOW - 3 * DAY_MS),
};

const CHANNELS = [
  {
    id: GENERAL,
    name: 'général',
    category: 'Café',
    topic: 'tout et rien',
    purpose: 'everyday chat',
    topics: 'plants, films, food',
    tone: 'warm teasing',
    lastMessageAt: SHIPPED_NOW - 2 * MINUTE_MS,
    messageCount: 900,
    days: { [utcDay(SHIPPED_NOW)]: 40 },
    topWriters: [
      { id: ANA, count: 30 },
      { id: NIKOS, count: 20 },
    ],
    updatedAt: iso(SHIPPED_NOW - 8 * DAY_MS),
  },
  {
    id: GARDEN,
    name: 'jardin',
    category: 'Café',
    topic: null,
    purpose: 'garden photos',
    topics: 'seeds',
    tone: 'calm',
    lastMessageAt: SHIPPED_NOW - 20 * MINUTE_MS,
    messageCount: 120,
    days: {},
  },
  {
    id: DIARY,
    name: 'journal',
    category: 'Notes',
    topic: 'one member per thread',
    purpose: 'personal diaries',
    topics: 'daily life',
    tone: 'quiet',
    lastMessageAt: SHIPPED_NOW - 5 * MINUTE_MS,
    messageCount: 60,
    days: {},
  },
];

const LORE = [
  {
    id: 'l1',
    title: 'Le grand gel',
    keys: ['tomate'],
    text: 'The winter the balcony tomatoes froze.',
    always: false,
    source: 'analyzer',
    weight: 3,
  },
];

const CUSTOM_EMOJI = [
  { id: 'E1', name: 'zoe_wave' },
  { id: 'E2', name: 'tomate_triste' },
];

const RECENT_LINES = [
  {
    id: 1,
    at: SHIPPED_NOW - 2 * HOUR_MS,
    addedAt: iso(SHIPPED_NOW - HOUR_MS),
    placeId: GARDEN,
    text: `<@${NIKOS}> planted garlic`,
    who: [NIKOS],
    weight: 2,
  },
];

const LOOKUP_RESULT = {
  query: 'tomato frost',
  text: 'Tomatoes die below zero degrees [1].',
  sources: [{ title: 'Garden notes', url: 'https://www.example.com/frost', site: 'example.com' }],
};

/**
 * A discord.js-shaped message, enough for normalizeMessage: `author` a PEOPLE entry, media as
 * plain lists (attachments `{ id, name, contentType, url, size?, duration? }`, embeds as Discord
 * sends them, stickers `{ id, name, format }`, reactions `{ name, id?, count, me? }`).
 */
function rawMessage(
  channel: { id: string; name: string | null; category?: string | null; topic?: string | null },
  {
    ts,
    author,
    content = '',
    attachments = [],
    embeds = [],
    stickers = [],
    reactions = [],
    replyTo = null,
    mentions = [],
    forwarded = null,
  }: {
    ts: number;
    author: { id: string; name: string };
    content?: string;
    attachments?: Array<{ id: string; [key: string]: unknown }>;
    embeds?: Array<unknown>;
    stickers?: Array<{ id: string; [key: string]: unknown }>;
    reactions?: Array<{ name: string; id?: string; count: number; me?: boolean }>;
    replyTo?: string | null;
    mentions?: Array<string>;
    forwarded?: string | null;
  }
) {
  // The same id on every call: the time, and the channel as the increment.
  const id = SnowflakeUtil.generate({ timestamp: ts, increment: CHANNEL_INCREMENT[channel.id] ?? 0n }).toString();
  return {
    id,
    channelId: channel.id,
    channel: {
      name: channel.name,
      parent: channel.category ? { name: channel.category } : null,
      topic: channel.topic ?? null,
    },
    guild: null,
    author: { id: author.id, bot: false, globalName: author.name, username: author.name },
    member: { displayName: author.name },
    content,
    cleanContent: content,
    createdTimestamp: ts,
    reference: replyTo ? { messageId: replyTo } : null,
    attachments: new Map(attachments.map((a) => [a.id, a])),
    embeds,
    stickers: new Map(stickers.map((s) => [s.id, s])),
    messageSnapshots: new Map(
      forwarded
        ? [
            [
              'fwd',
              { content: forwarded, cleanContent: forwarded, attachments: new Map(), embeds: [], stickers: new Map() },
            ],
          ]
        : []
    ),
    mentions: { users: new Map(mentions.map((accountId) => [accountId, { id: accountId }])) },
    reactions: {
      cache: new Map(
        reactions.map((r, i) => [
          String(i),
          { emoji: { name: r.name, id: r.id ?? null }, count: r.count, me: r.me ?? false },
        ])
      ),
    },
    flags: { has: () => false },
  };
}

const GENERAL_INFO = { id: GENERAL, name: 'général', category: 'Café', topic: 'tout et rien' };

const GARDEN_INFO = { id: GARDEN, name: 'jardin', category: 'Café', topic: null };

const GIF_EMBED = {
  url: 'https://tenor.com/view/cat-wave-123',
  provider: { name: 'Tenor' },
  thumbnail: { url: 'https://media.tenor.com/cat.png' },
  video: { url: 'https://media.tenor.com/cat.mp4' },
};

const PAGE_EMBED = {
  url: 'https://example.org/tomates',
  title: 'Tomates en pot',
  description: 'Comment cultiver des tomates sur un balcon',
};

/** The chat of #général the turn answers, oldest first: every kind of media the transcript renders. */
function generalRaws() {
  const at = (minutes: number) => SHIPPED_NOW - minutes * MINUTE_MS;
  const raws: Array<ReturnType<typeof rawMessage>> = [];
  const add = (fields: Parameters<typeof rawMessage>[1]) => {
    const raw = rawMessage(GENERAL_INFO, fields);
    raws.push(raw);
    return raw;
  };
  add({
    ts: at(55),
    author: PEOPLE[NIKOS],
    content: 'bonjour à tous, la tomate a gelé',
    reactions: [
      { name: '🍅', count: 3 },
      { name: 'zoe_wave', id: 'E1', count: 1, me: true },
    ],
  });
  const own = add({ ts: at(50), author: PEOPLE[SELF_ID], content: 'oh non, pauvre tomate' });
  add({
    ts: at(45),
    author: PEOPLE[BJORN],
    content: 'la preuve',
    attachments: [
      {
        id: '800000000000000001',
        name: 'photo.png',
        contentType: 'image/png',
        url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
        size: 2000,
      },
    ],
  });
  add({
    ts: at(40),
    author: PEOPLE[NIKOS],
    content: 'regardez https://tenor.com/view/cat-wave-123',
    embeds: [GIF_EMBED],
  });
  const video = add({
    ts: at(35),
    author: PEOPLE[ANA],
    content: 'une vidéo des oranges',
    attachments: [
      {
        id: '800000000000000002',
        name: 'oranges.mp4',
        contentType: 'video/mp4',
        url: 'https://cdn.discordapp.com/attachments/1/2/oranges.mp4',
        size: 90000,
        duration: 20,
      },
    ],
  });
  add({ ts: at(30), author: PEOPLE[BJORN], content: 'un article https://example.org/tomates', embeds: [PAGE_EMBED] });
  add({
    ts: at(26),
    author: PEOPLE[ANA],
    content: '',
    stickers: [{ id: '810000000000000001', name: 'tomato_dance', format: 1 }],
  });
  add({
    ts: at(22),
    author: PEOPLE[NIKOS],
    content: 'mes graines',
    attachments: [
      {
        id: '800000000000000003',
        name: 'graines.txt',
        contentType: 'text/plain',
        url: 'https://cdn.discordapp.com/attachments/1/2/graines.txt',
        size: 40,
      },
    ],
  });
  add({ ts: at(18), author: PEOPLE[BJORN], content: 'vu ailleurs', forwarded: 'le gel arrive mardi' });
  add({ ts: at(14), author: PEOPLE[SELF_ID], content: 'jolie vidéo', replyTo: video.id });
  add({ ts: at(10), author: PEOPLE[NIKOS], content: 'Zoë, tu as aimé ?', replyTo: own.id });
  add({
    ts: at(2),
    author: PEOPLE[ANA],
    content: '@Zoë de quelle couleur sont les oranges dans la vidéo ? et quand gèle la tomate ?',
    mentions: [SELF_ID],
  });
  return raws;
}

const normalize = (raws: Array<ReturnType<typeof rawMessage>>) =>
  raws.map((raw) => {
    const media = SHIPPED.config.media;
    const line = normalizeMessage(raw, SELF_ID, {
      videoSites: media.video.sites,
    });
    // The interface's line names its channel natively; the core reads the same line under its place.
    return { ...line, placeId: line.channelId };
  });

/** A fetch stand-in for text attachment previews: every file reads the same short text. */
const previewFetch = async () => ({
  ok: true,
  headers: { get: () => null },
  text: async () => 'graines: tomate, basilic, ail',
});

/** The #général chat, normalized, text previews filled, oldest first. */
async function generalHistory() {
  return withTextPreviews(normalize(generalRaws()), 500, previewFetch);
}

/** Captions, watched videos and read pages for every media item of `history`, as a turn hands them in. */
function mediaMaps(history: ReturnType<typeof normalize>) {
  const descriptions = new Map();
  const videos = new Map();
  const reads = new Map();
  for (const message of history) {
    for (const item of (message.attachments ?? []) as Array<{ id: string; kind: string }>) {
      if (item.kind === 'image' || item.kind === 'gif') descriptions.set(item.id, 'a tomato plant covered in frost');
      if (item.kind === 'video')
        videos.set(item.id, {
          state: 'watched',
          text: 'a person juggles three oranges',
          answer: { question: 'what colour?', text: 'orange' },
        });
    }
    for (const link of (message.links ?? []) as Array<{ id: string; kind: string }>) {
      if (link.kind === 'gif') descriptions.set(link.id, 'a cat waves');
      else reads.set(link.id, 'How to grow tomatoes in pots on a balcony.');
    }
    for (const sticker of (message.stickers ?? []) as Array<{ id: string }>)
      descriptions.set(sticker.id, 'a dancing tomato');
  }
  return { descriptions, videos, reads };
}

/** The GIF library of the server, holding the GIF of the chat. */
function gifLibrary(history: ReturnType<typeof normalize>) {
  const gif = history.flatMap((m) => m.links ?? []).find((link) => link.kind === 'gif')!;
  return {
    nextId: 2,
    entries: {
      [gif.id]: {
        id: 'g1',
        kind: 'link',
        url: gif.url,
        site: 'tenor.com',
        itemId: gif.id,
        count: 3,
        last: SHIPPED_NOW - DAY_MS,
        firstSeen: SHIPPED_NOW - 9 * DAY_MS,
      },
    },
  };
}

/** One neighbour channel with a line of its own. */
function neighbors() {
  const line = rawMessage(GARDEN_INFO, {
    ts: SHIPPED_NOW - 20 * MINUTE_MS,
    author: PEOPLE[BJORN],
    content: 'les semis sont sortis',
  });
  return [{ placeId: GARDEN, channelName: 'jardin', readOnly: false, messages: normalize([line]) }];
}

/** The input of a server turn in #général answering Ana, every optional block given. */
async function turnInput(overrides: Record<string, unknown> = {}) {
  const history = await generalHistory();
  const trigger = history.at(-1);
  const { descriptions, videos, reads } = mediaMaps(history);
  const config = shippedConfig({
    // PR 7d: the switches are code; the private chats are `dm.enabled`.
    dm: { enabled: true },
    memory: { mainChannelIds: [GENERAL] },
  });
  const input = {
    config,
    prompts: SHIPPED.prompts,
    calibrator: createCalibrator(),
    mode: 'reply',
    forced: false,
    now: SHIPPED_NOW,
    selfName: SELF_NAME,
    history,
    neighbors: neighbors(),
    trigger,
    triggerKind: 'mention',
    placeMemory: GUILD_MEMORY,
    interlocutor: PROFILES[ANA],
    otherProfiles: [PROFILES[NIKOS], PROFILES[BJORN]],
    candidateProfiles: Object.values(PROFILES),
    nameOf,
    channels: CHANNELS,
    loreEntries: LORE,
    currentChannelId: GENERAL,
    descriptions,
    neighborDescriptions: new Map(),
    videos,
    reads,
    lookup: LOOKUP_RESULT,
    searchAvailable: true,
    drawQuota: { spent: false, userSpent: false },
    customEmoji: CUSTOM_EMOJI,
    mediaCache: { 'emoji:E1': { text: 'a small waving hand', ts: SHIPPED_NOW - DAY_MS } },
    gifs: gifLibrary(history),
    readOnlyIds: new Set([DIARY]),
    recentLines: RECENT_LINES,
    recentAudience: () => true,
    ...overrides,
  };
  // Every request is built on its turn frame (slice 7).
  return Object.hasOwn(overrides, 'frame') ? input : framed(input);
}

test('buildRequest: an inner turn fills main, persona, rules, format, turn/inner.md and every labels.wake line', async () => {
  const wake = {
    kind: 'intention_due',
    items: [
      { kind: 'intention_due', intentionIds: ['i1'] },
      { kind: 'errand_deadline', intentionIds: ['i2'], errandId: 'T1' },
      { kind: 'heartbeat', intentionIds: [] },
    ],
    intentions: [
      { id: 'i1', purpose: 'ask Ana how the tomatoes are doing', dueAt: SHIPPED_NOW - HOUR_MS },
      { id: 'i2', purpose: 'share what the errand found', dueAt: null },
    ],
    now: SHIPPED_NOW,
    timezone: 'UTC',
    channels: ['général'],
  };
  const request = buildRequest(
    await turnInput({
      mode: 'inner',
      trigger: null,
      triggerKind: 'inner',
      interlocutor: null,
      wakeKind: 'intention_due',
      awake: awakeLines(wake, LABELS, { locale: LABELS.locale }).join('\n'),
      frame: frameOf({
        mode: 'inner',
        triggerKind: 'inner',
        wakeKind: 'intention_due',
        interface: 'discord',
        chain: [],
        dm: null,
        trigger: null,
        author: null,
        now: SHIPPED_NOW,
        timezone: 'UTC',
      }),
    })
  );
  // Slice 5: `<wake>` is gone; the kind lines (awakeLines) fill `<spatial_awareness>` of the frame, here an intention
  // turn with no place, and the review kind left with it.
  const text = assertFilled(
    request.messages,
    { files: LOADS.inner, blocks: ['spatial_awareness', 'task'] },
    'inner turn'
  );
  const spatial = text.slice(text.indexOf('<spatial_awareness>'), text.indexOf('</spatial_awareness>'));
  assert.ok(spatial.includes('ask Ana how the tomatoes are doing'), spatial);
  const { heartbeat } = LABELS.wake.kinds;
  assert.ok(spatial.includes(heartbeat), spatial);
});
