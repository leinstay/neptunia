// Every shipped prompt is filled by its builder. Each request the bot can send is built here
// from the TRACKED layer -- prompts/*.md and prompts/labels.json read the way src/hot.js reads
// them for a deployment without prompts.local/, and config.json without config.local.json --
// through the builder or the factory that sends it, with fakes only at the edges (no network,
// no data/, no real Discord, no model). Every request must leave no `{{placeholder}}` and no
// label `{key}` unfilled, must carry each prompt file it loads whole, and must render the blocks
// its labels head; together the requests load every tracked prompt file. A placeholder added to
// a prompt without a filler, a filler dropped from a builder, a prompt file no builder sends or
// a label key missing from labels.json fails here instead of reaching the model as literal text.
// The switches a request needs (the web lookup, video vision) are
// turned on per test; every number comes from the shipped config.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowflakeUtil } from 'discord.js';
import { deepMerge, isPlainObject } from '../src/config.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDay, zonedDay } from '../src/time.js';
import {
  buildDiaryPlanRequest,
  buildDrawPrompt,
  buildRequest,
  hasRequiredLabels,
  userText,
} from '../src/behavior/prompt.js';
import { parseSeedFamilies, pickSeeds, renderSeedsBlock } from '../src/behavior/diary.js';
import { fill, formatDate } from '../src/format.js';
import { createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.js';
import { createRecall } from '../src/behavior/recall-run.js';
import { createChannelRouter } from '../src/behavior/route-channel.js';
import { createParticipationPicker } from '../src/behavior/participation-pick.js';
import { askPlanner } from '../src/behavior/planner.js';
import { createTagHistory } from '../src/behavior/mention.js';
import { createMissed } from '../src/behavior/missed.js';
import { createMessageHandler } from '../src/behavior/pipeline.js';
import { normalizeMessage, normalizeOptions, toEvent } from '../interfaces/discord/index.js';
import { takeSnapshot } from '../src/behavior/snapshot.ts';
import { onWorld, onWorldIface, useIface, useSelf, world, worldChannels } from './fixtures/turn-world.ts';

/** @param {Parameters<typeof worldChannels>[1]} channels */
const worldChannelsOf = (channels) => worldChannels(GUILD, channels);
import { withTextPreviews } from '../src/media/text-preview.ts';
import { createCalibrator } from '../src/llm/tokens.js';
import { createDescriber } from '../src/memory/describe.js';
import { createAvatarQueue } from '../src/memory/avatar-queue.js';
import { createLookup } from '../src/web/lookup.js';
import { loadSkills } from '../src/tools/registry.ts';
import { listSkills } from '../src/tools/gateway.ts';
import { CATALOGUE } from '../src/tools/codes.ts';
import { catalogueProblems } from '../tools/lib/labels-catalogue.mjs';
import { feedbackInTurnText, wakeBlockText } from '../src/behavior/wake.js';
import { labels as contractLabels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

// The conversations of the turns, the pipeline and the classifiers are held by a fake interface named `fake`, the
// persona being `SELF_ID`; the recall runner keeps reading the platform's own objects through the recall bridge.
useIface('fake');
useSelf('900000000000000001');
const createTurnRunner = onWorld(createRealTurnRunner);

// ---- the shipped layer --------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPTS_DIR = path.join(ROOT, 'prompts');

/** The tracked prompt files, by name (the file name without `.md`). */
const PROMPT_FILES = fs
  .readdirSync(PROMPTS_DIR)
  .filter((file) => file.endsWith('.md'))
  .map((file) => path.basename(file, '.md'))
  .sort();

const BOM = String.fromCharCode(0xfeff);

/** `prompts/<name>.md` as src/hot.js reads it: the BOM and carriage returns dropped, trimmed. */
function readPrompt(name) {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, '\n').trim();
}

/** The tracked layer alone: config.json and prompts/ with labels.json, never a local override. */
const SHIPPED = {
  config: JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: JSON.parse(fs.readFileSync(path.join(PROMPTS_DIR, 'labels.json'), 'utf8')),
  },
};
const LABELS = SHIPPED.prompts.labels;

/** Tracked prompt files no request here can build, each with the reason. */
const NOT_BUILT = {
  // The voice-message preparation pass (src/speech/prepare.js) runs inside the speech pipeline, whose request tests/speech-prepare.test.js checks.
  'speech-prepare': 'built by the speech pipeline (src/speech/prepare.js), checked in tests/speech-prepare.test.js',
  // Built inside the createMessageHandler closure of src/behavior/pipeline.js (buildFollowUpRequest),
  // which fetches its own history: no seam reaches it (owner decision O-9).
  address: 'built inside the src/behavior/pipeline.js closure (O-9)',
  // Split into families and drawn from line by line (src/behavior/diary.js#pickSeeds): the plan
  // request carries a few random lines in <seeds>, never the file whole.
  'diary-seeds': 'drawn from line by line into <seeds> (src/behavior/diary.js#pickSeeds), never sent whole',
  // Her memory session and the description review build their requests over the memory database, not from a turn:
  // tests/memory-db-session.test.js and tests/memory-db-describe.test.js check what they load.
  'memory-session': 'built over the memory database (src/memory/db/session.js)',
  'description-draft': 'built over the memory database (src/memory/db/describe.js)',
  'description-check': 'built over the memory database (src/memory/db/describe.js)',
  // The errand agents' prompts are not here: they live in agents/<id>/prompt.md, read by the
  // agent runner process (src/agent-runner/profiles.js), never by a bot request.
};

/**
 * A prompt that carries `{{` or a `{key}` as text on purpose: its file name -> `{ literal, why }`.
 * The literal may remain in a request; anything else in braces may not. None today.
 */
const LITERAL_BRACES = {};

/** `text` without the literals of LITERAL_BRACES. */
function withoutLiterals(text) {
  let rest = text;
  for (const { literal } of Object.values(LITERAL_BRACES)) rest = rest.split(literal).join('');
  return rest;
}

/**
 * Label keys the code renders that the tracked labels.json does not carry yet, each with the
 * reason. Until the dev agent adds them, the block they head is simply left out of the request.
 */
const PENDING_LABELS = {
  'recent.header': 'the <recent> view (spec-recall R3): its wording is a text task for the dev agent',
  'recent.line': 'the <recent> view (spec-recall R3): its wording is a text task for the dev agent',
  'recent.lineIn': 'the <recent> view (spec-recall R3): its wording is a text task for the dev agent',
  'recent.episode': 'the <recent> view (spec-recall R3): its wording is a text task for the dev agent',
};

const SYSTEM = ['system-prompt', 'character-card', 'rules', 'format'];

/** The prompt files each request below must carry whole, by request. */
const LOADS = {
  reply: [...SYSTEM, 'reply'],
  followUp: [...SYSTEM, 'follow-up'],
  overheard: [...SYSTEM, 'overheard'],
  errandResult: [...SYSTEM, 'errand-result'],
  interject: [...SYSTEM, 'interject'],
  forcedInitiate: [...SYSTEM, 'initiate', 'forced'],
  private: [...SYSTEM, 'reply', 'private'],
  routed: [...SYSTEM, 'reply'],
  noticed: [...SYSTEM, 'elsewhere'],
  draw: ['draw', 'appearance'],
  diary: [...SYSTEM, 'diary', 'world'],
  inner: [...SYSTEM, 'inner'],
  heartbeat: [...SYSTEM, 'heartbeat'],
  diaryPlan: ['diary-plan', 'world'],
  describe: ['describe'],
  avatar: ['avatar'],
  describeGif: ['describe-gif'],
  describeVideo: ['describe-video'],
  rewatch: ['rewatch'],
  rewatchAnswer: ['rewatch-answer'],
  readLink: ['read-link'],
  lookup: ['lookup'],
  searchSummary: ['search-summary'],
  recallSummary: ['recall-summary'],
  routeChannel: ['route-channel'],
  participationPick: ['participation-pick'],
  planner: ['planner'],
  room: ['room'],
  split: ['split'],
  merge: ['merge'],
  missed: ['missed'],
  gifPick: ['gif-pick'],
  turn: [...SYSTEM, 'reply'],
};

/** The shipped config.json with `overrides` deep-merged over a fresh copy. */
function shippedConfig(overrides = {}) {
  return deepMerge(structuredClone(SHIPPED.config), overrides);
}

/** A live view over the shipped layer, the config overridden as given. */
function shippedHot(overrides = {}) {
  return { config: shippedConfig(overrides), prompts: SHIPPED.prompts };
}

// ---- the checks -----------------------------------------------------------------

/** The text of one message content: a string as is, an array of parts as its text parts. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Every text a request carries, as one string. */
function requestText(messages) {
  return messages.map((message) => contentText(message.content)).join('\n\n');
}

/** The double-brace sequences left in `text`, LITERAL_BRACES aside. */
function strayPlaceholders(text) {
  return [...new Set(withoutLiterals(text).match(/\{\{[^{}\n]{0,40}\}\}|\{\{/g) ?? [])];
}

/** The single-brace `{key}` label placeholders left in `text`, LITERAL_BRACES aside. */
function strayLabelKeys(text) {
  return [...new Set(withoutLiterals(text).match(/\{[A-Za-z_]\w*\}/g) ?? [])];
}

/** The lines of prompt `name` without a placeholder: a request that loads the file carries each one verbatim. */
function literalLines(name) {
  const text = SHIPPED.prompts[name];
  assert.equal(typeof text, 'string', `prompts/${name}.md is not loaded`);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('{{'));
}

/** Whether `text` carries prompt `name` whole. */
function carries(text, name) {
  return literalLines(name).every((line) => text.includes(line));
}

/**
 * Asserts one built request: no `{{placeholder}}` and no label `{key}` left, every prompt file of
 * `files` carried whole, every block of `blocks` rendered. Returns the request's text.
 */
function assertFilled(messages, { files = [], blocks = [] }, where) {
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
  for (const tag of blocks) assert.ok(text.includes(`<${tag}>\n`), `${where}: no <${tag}> block`);
  return text;
}

/** Every key path of a labels object (`a.b.c`), arrays counted as one value. */
function keyPaths(value, prefix = '') {
  return Object.entries(value).flatMap(([key, entry]) =>
    isPlainObject(entry) ? keyPaths(entry, `${prefix}${key}.`) : [`${prefix}${key}`]
  );
}

// ---- the scene: one server, its members and channels --------------------------------

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const GUILD = '600000000000000001';
const SELF_ID = '900000000000000001';
const SELF_NAME = 'Zoë';
const ANA = '411111111111111111';
const NIKOS = '422222222222222222';
const BJORN = '433333333333333333';
const ELODIE = '444444444444444444';
const GENERAL = '700000000000000001';
const GARDEN = '700000000000000002';
const DIARY = '700000000000000003';
const CHANNEL_INCREMENT = { [GENERAL]: 1n, [GARDEN]: 2n, [DIARY]: 3n };

const PEOPLE = {
  [ANA]: { id: ANA, name: 'Ana' },
  [NIKOS]: { id: NIKOS, name: 'Nikos' },
  [BJORN]: { id: BJORN, name: 'Björn' },
  [SELF_ID]: { id: SELF_ID, name: SELF_NAME },
};

const iso = (ms) => new Date(ms).toISOString();

/** A stored member profile, every field the renderers read filled. */
function profile(id, names, extra = {}) {
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
        firstSeen: iso(NOW - 30 * DAY_MS),
        lastSeen: iso(NOW - DAY_MS),
      },
      { topic: 'chess', note: '', weight: 1, firstSeen: iso(NOW - 200 * DAY_MS), lastSeen: iso(NOW - 200 * DAY_MS) },
    ],
    details: [
      {
        id: 1,
        text: 'lives near the sea',
        weight: 3,
        firstSeen: iso(NOW - 40 * DAY_MS),
        lastSeen: iso(NOW - 2 * DAY_MS),
      },
    ],
    aliases: [
      { name: `${names[0].slice(0, 3)}ou`, weight: 3, firstSeen: iso(NOW - 20 * DAY_MS), lastSeen: iso(NOW - DAY_MS) },
    ],
    relationship: 'an old friend of the chat',
    relationshipScore: 20,
    relationshipWrittenAt: iso(NOW - 10 * DAY_MS),
    affinity: { score: 22, reason: 'brought crêpes to the meetup', history: [{ delta: 5, ts: NOW - 3 * DAY_MS }] },
    episodes: [
      {
        date: '2026-09-28',
        what: 'taught the persona a card trick',
        quote: 'regarde bien',
        feeling: 'delighted',
        weight: 3,
        addedAt: iso(NOW - 7 * DAY_MS),
      },
      {
        date: '2026-10-04',
        what: 'asked about the weather',
        quote: '',
        feeling: 'calm',
        weight: 1,
        addedAt: iso(NOW - DAY_MS),
      },
    ],
    messageCount: 420,
    firstSeen: iso(NOW - 90 * DAY_MS),
    lastSeen: iso(NOW - 2 * MINUTE_MS),
    ...extra,
  };
}

const PROFILES = {
  [ANA]: profile(ANA, ['Ana', 'Anaïs']),
  [NIKOS]: profile(NIKOS, ['Nikos']),
  [BJORN]: profile(BJORN, ['Björn']),
  [ELODIE]: profile(ELODIE, ['Élodie']),
};

const nameOf = (id) => PROFILES[id]?.names?.[0] ?? null;

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
      firstSeen: iso(NOW - 9 * DAY_MS),
      lastSeen: iso(NOW - DAY_MS),
    },
    { id: 2, text: 'never spoil a film', weight: 1, firstSeen: iso(NOW - DAY_MS), lastSeen: iso(NOW - DAY_MS) },
  ],
  emojiUsage: { E1: { name: 'zoe_wave', count: 4, last: NOW - DAY_MS } },
  updatedAt: iso(NOW - 3 * DAY_MS),
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
    lastMessageAt: NOW - 2 * MINUTE_MS,
    messageCount: 900,
    days: { [utcDay(NOW)]: 40 },
    topWriters: [
      { id: ANA, count: 30 },
      { id: NIKOS, count: 20 },
    ],
    updatedAt: iso(NOW - 8 * DAY_MS),
  },
  {
    id: GARDEN,
    name: 'jardin',
    category: 'Café',
    topic: null,
    purpose: 'garden photos',
    topics: 'seeds',
    tone: 'calm',
    lastMessageAt: NOW - 20 * MINUTE_MS,
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
    lastMessageAt: NOW - 5 * MINUTE_MS,
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
    at: NOW - 2 * HOUR_MS,
    addedAt: iso(NOW - HOUR_MS),
    channelId: GARDEN,
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
  channel,
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
    mentions: { users: new Map(mentions.map((userId) => [userId, { id: userId }])) },
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
const DIARY_INFO = { id: DIARY, name: 'journal', category: 'Notes', topic: 'one member per thread' };

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
  const at = (minutes) => NOW - minutes * MINUTE_MS;
  const raws = [];
  const add = (fields) => {
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

const normalize = (raws) =>
  raws.map((raw) =>
    normalizeMessage(raw, SELF_ID, { embedTextChars: 200, videoSites: SHIPPED.config.media.video.sites })
  );

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
function mediaMaps(history) {
  const descriptions = new Map();
  const videos = new Map();
  const reads = new Map();
  for (const message of history) {
    for (const item of message.attachments ?? []) {
      if (item.kind === 'image' || item.kind === 'gif') descriptions.set(item.id, 'a tomato plant covered in frost');
      if (item.kind === 'video')
        videos.set(item.id, {
          state: 'watched',
          text: 'a person juggles three oranges',
          answer: { question: 'what colour?', text: 'orange' },
        });
    }
    for (const link of message.links ?? []) {
      if (link.kind === 'gif') descriptions.set(link.id, 'a cat waves');
      else reads.set(link.id, 'How to grow tomatoes in pots on a balcony.');
    }
    for (const sticker of message.stickers ?? []) descriptions.set(sticker.id, 'a dancing tomato');
  }
  return { descriptions, videos, reads };
}

/** The GIF library of the server, holding the GIF of the chat. */
function gifLibrary(history) {
  const gif = history.flatMap((m) => m.links ?? []).find((link) => link.kind === 'gif');
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
        last: NOW - DAY_MS,
        firstSeen: NOW - 9 * DAY_MS,
      },
    },
  };
}

/** One neighbour channel with a line of its own. */
function neighbors() {
  const line = rawMessage(GARDEN_INFO, {
    ts: NOW - 20 * MINUTE_MS,
    author: PEOPLE[BJORN],
    content: 'les semis sont sortis',
  });
  return [{ channelId: GARDEN, channelName: 'jardin', readOnly: false, messages: normalize([line]) }];
}

/** The input of a server turn in #général answering Ana, every optional block given. */
async function turnInput(overrides = {}) {
  const history = await generalHistory();
  const trigger = history.at(-1);
  const { descriptions, videos, reads } = mediaMaps(history);
  const config = shippedConfig({
    features: { webLookup: true, imageGeneration: true, privateMessages: true, videoDescriptions: true },
    memory: { mainChannelIds: [GENERAL] },
  });
  return {
    config,
    prompts: SHIPPED.prompts,
    calibrator: createCalibrator(),
    mode: 'reply',
    forced: false,
    now: NOW,
    selfName: SELF_NAME,
    history,
    neighbors: neighbors(),
    trigger,
    triggerKind: 'mention',
    guildMemory: GUILD_MEMORY,
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
    mediaCache: { 'emoji:E1': { text: 'a small waving hand', ts: NOW - DAY_MS } },
    gifs: gifLibrary(history),
    readOnlyIds: new Set([DIARY]),
    recentLines: RECENT_LINES,
    recentAudience: () => true,
    ...overrides,
  };
}

// The blocks a fully fed server turn renders, each headed or filled by labels.
const TURN_BLOCKS = [
  'now',
  'senses',
  'about_chat',
  'emoji',
  'gifs',
  'server',
  'lore',
  'self_facts',
  'people',
  'other_channels',
  'lookup',
  'chat',
  'tempo',
  'task',
];

// ---- the layer itself ---------------------------------------------------------------

test('prompts: every tracked prompt file is loaded by a request built here, or named with the reason it cannot be', () => {
  const loaded = new Set(Object.values(LOADS).flat());
  const named = [...loaded, ...Object.keys(NOT_BUILT), ...Object.keys(LITERAL_BRACES)];
  assert.deepEqual(
    named.filter((name) => !PROMPT_FILES.includes(name)),
    [],
    'a name here that is no tracked prompt file'
  );
  assert.deepEqual(
    PROMPT_FILES.filter((name) => !loaded.has(name) && !Object.hasOwn(NOT_BUILT, name)),
    [],
    'a tracked prompt file that no request built here loads'
  );
  for (const [name, { literal }] of Object.entries(LITERAL_BRACES))
    assert.ok(SHIPPED.prompts[name].includes(literal), `${name}: its literal braces are gone`);
});

test('labels: the tracked labels.json passes the startup check and carries every key the code renders', () => {
  assert.equal(hasRequiredLabels(LABELS), true);
  const shipped = new Set(keyPaths(LABELS));
  const missing = keyPaths(contractLabels).filter((key) => !shipped.has(key) && !Object.hasOwn(PENDING_LABELS, key));
  assert.deepEqual(missing, [], 'label keys of the contract missing from prompts/labels.json');
});

test('labels: every code of the catalogue has its words in the tracked labels.json and no words lack their code', () => {
  assert.deepEqual(catalogueProblems({ catalogue: CATALOGUE, labels: LABELS }), []);
});

// ---- the chat turn ----------------------------------------------------------------

test('buildRequest: a reply fills system-prompt, character-card, rules, format and reply for every trigger kind', async () => {
  for (const triggerKind of ['mention', 'reply', 'name', 'followUp']) {
    const request = buildRequest(await turnInput({ triggerKind }));
    // A follow-up takes the follow-up task instead of reply.md; a reply with no tagged state stays on reply.md.
    const files = triggerKind === 'followUp' ? LOADS.followUp : LOADS.reply;
    const text = assertFilled(request.messages, { files, blocks: TURN_BLOCKS }, `reply (${triggerKind})`);
    assert.equal(carries(text, 'reply'), triggerKind !== 'followUp', `${triggerKind}: which task file frames the turn`);
    assert.ok(text.includes(LABELS.triggers[triggerKind]), `${triggerKind}: the trigger label fills {{trigger}}`);
  }
  // A Discord reply to the persona: untagged takes the follow-up task, tagged keeps reply.md.
  const untagged = buildRequest(await turnInput({ triggerKind: 'reply', taggedCall: false }));
  const untaggedText = assertFilled(
    untagged.messages,
    { files: LOADS.followUp, blocks: TURN_BLOCKS },
    'reply (untagged reply)'
  );
  assert.ok(!carries(untaggedText, 'reply'), 'an untagged reply: reply.md is not sent as well');
  const tagged = buildRequest(await turnInput({ triggerKind: 'reply', taggedCall: true }));
  const taggedText = assertFilled(tagged.messages, { files: LOADS.reply, blocks: TURN_BLOCKS }, 'reply (tagged reply)');
  assert.ok(!carries(taggedText, 'follow-up'), 'a tagged reply: the follow-up task is not sent');
});

test('buildRequest: the skills protocol and an asked-for catalogue fill labels.tools from the shipped skill texts', async () => {
  const texts = JSON.parse(fs.readFileSync(path.join(PROMPTS_DIR, '..', 'config', 'tools.json'), 'utf8'));
  const shipped = shippedConfig();
  // message.edit granted to the persona (the bot's user, as `/nep access grant` stores it).
  const self = '799999999999999999';
  const config = {
    ...shipped,
    bot: { ...shipped.bot, access: { 'message.edit': { everyone: false, roles: [], users: [self] } } },
  };
  // Stand-ins named as the operations, with no operation behind them: the shipped texts are keyed by those names.
  const registry = loadSkills(
    ['message.create', 'message.edit', 'message.delete']
      .map((name) => ({
        name,
        op: null,
        argsSchema: { type: 'object' },
        effects: 'write',
        costClass: 'free',
        targets: null,
      }))
      .map((definition) =>
        definition.name !== 'message.edit'
          ? definition
          : {
              ...definition,
              // Every form of an argument: required, the body option, a range, an enum. A command makes it a
              // derived skill, so an operation stands behind it (message.edit is her own: no requester right).
              op: 'message.edit',
              argsSchema: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  text: { type: 'string' },
                  n: { type: 'integer', minimum: 1, maximum: 50 },
                  kind: { type: 'string', enum: ['turn', 'all'] },
                },
                required: ['message', 'text'],
                additionalProperties: false,
              },
              dispatch: { op: 'message.edit', toOp: () => ({}), body: 'text' },
            }
      ),
    { getOp: (name) => ({ name, rights: { kind: 'write' } }) }
  );
  const rows = listSkills({
    config,
    selfId: self,
    texts,
    requester: { id: ANA },
    audience: { conversationId: GENERAL },
    registry,
  });
  const request = buildRequest(await turnInput({ skillsInventory: rows }));
  const text = assertFilled(
    request.messages,
    { files: LOADS.reply, blocks: [...TURN_BLOCKS, 'skills'] },
    'reply (skills catalogue)'
  );
  // Only what she may use now: carried over and allowed; a closed skill is not listed.
  assert.ok(text.includes(`(${LABELS.tools.access.allowed})`), 'labels.tools.access.allowed');
  // message.create, carried over, has no shipped texts yet: listed by its name alone.
  assert.ok(
    texts['message.create'] !== undefined || text.includes('\nmessage.create\n'),
    'a skill without texts by its name'
  );
  assert.ok(!text.includes('message.delete'), 'a closed skill is not listed');
  const forms = LABELS.tools.args;
  const args = fill(forms.list, {
    list: [
      fill(forms.required, { arg: 'message' }),
      fill(forms.required, { arg: 'text' }),
      fill(forms.range, { arg: 'n', min: 1, max: 50 }),
      fill(forms.values, { arg: 'kind', values: 'turn|all' }),
    ].join(', '),
  });
  assert.ok(
    text.includes(
      fill(LABELS.tools.line, {
        name: 'message.edit',
        title: texts['message.edit'].title,
        whenToUse: texts['message.edit'].whenToUse,
        access: LABELS.tools.access.allowed,
        args,
      })
    ),
    'the arguments through labels.tools.args'
  );
});

test('buildRequest: the text transport describes her tools in <tools> in the stable part, the same for another requester', async () => {
  const body = [LABELS.tools.toolsText.lead, '{"name":"lore.list"}', LABELS.tools.toolsText.protocol].join('\n');
  const request = buildRequest(await turnInput({ toolsBlock: body }));
  assertFilled(request.messages, { files: LOADS.reply, blocks: [...TURN_BLOCKS, 'tools'] }, 'reply (tools in text)');
  const stable = request.messages[1].content[0];
  assert.equal(stable.cacheSegment, 'stable');
  assert.ok(stable.text.includes(`<tools>\n${body}\n</tools>`), stable.text);
  // Another member asking in another channel: the cached part does not move.
  const other = buildRequest(
    await turnInput({ toolsBlock: body, interlocutor: PROFILES[NIKOS], currentChannelId: DIARY })
  );
  assert.equal(other.messages[1].content[0].text, stable.text);
  // The native transport sends no block: the tools are a request field.
  assert.ok(!buildRequest(await turnInput({})).messages[1].content[0].text.includes('<tools>'));
});

test('buildRequest: an overheard line fills overheard.md in place of the reply task', async () => {
  const request = buildRequest(await turnInput({ triggerKind: 'overheard' }));
  const text = assertFilled(request.messages, { files: LOADS.overheard, blocks: TURN_BLOCKS }, 'overheard');
  assert.ok(!carries(text, 'reply'), 'the reply task is not sent as well');
});

test('buildRequest: the turn a finished errand opens without an origin message fills errand-result.md in place of interject.md', async () => {
  const history = await generalHistory();
  const request = buildRequest(
    await turnInput({
      mode: 'interject',
      trigger: null,
      triggerKind: 'errand',
      interlocutor: null,
      focus: history.at(-2),
    })
  );
  const text = assertFilled(
    request.messages,
    { files: LOADS.errandResult, blocks: ['senses', 'chat', 'tempo', 'task'] },
    'errand-result'
  );
  assert.ok(!carries(text, 'interject'), 'interject.md is not sent as well');
});

test('buildRequest: interject and a forced initiate fill their task, forced.md after it, and the room line', async () => {
  const history = await generalHistory();
  const focus = history.at(-2);
  const interject = buildRequest(
    await turnInput({ mode: 'interject', trigger: null, triggerKind: null, interlocutor: null, focus })
  );
  const text = assertFilled(
    interject.messages,
    { files: LOADS.interject, blocks: ['senses', 'chat', 'tempo', 'task'] },
    'interject'
  );
  assert.ok(!carries(text, 'forced'), 'forced.md only on a forced turn');
  const [focusIndex] = [...interject.idByIndex].find(([, id]) => id === focus.id) ?? [];
  assert.ok(
    text.includes(fill(LABELS.room.focus, { author: focus.authorName, target: `#${focusIndex}` })),
    'room.focus follows the task'
  );
  const initiate = buildRequest(
    await turnInput({ mode: 'initiate', forced: true, trigger: null, triggerKind: null, interlocutor: null })
  );
  assertFilled(
    initiate.messages,
    { files: LOADS.forcedInitiate, blocks: ['senses', 'chat', 'tempo', 'task'] },
    'forced initiate'
  );
});

test('buildRequest: a private chat fills private.md after the reply task', async () => {
  const dm = { id: 'dm1', name: null, category: null, topic: null };
  const at = (minutes) => NOW - minutes * MINUTE_MS;
  const history = normalize([
    rawMessage(dm, { ts: at(6), author: PEOPLE[ANA], content: 'tu es là ?' }),
    rawMessage(dm, { ts: at(5), author: PEOPLE[SELF_ID], content: 'oui' }),
    rawMessage(dm, { ts: at(1), author: PEOPLE[ANA], content: 'je peux te dire un secret ?' }),
  ]);
  const privateProfile = {
    relationship: 'a quiet confidante',
    affinity: { score: 30, reason: 'shared a secret', history: [] },
    episodes: [
      {
        date: '2026-10-03',
        what: 'told the persona about a new job',
        quote: 'chut',
        feeling: 'trusted',
        weight: 3,
        addedAt: iso(NOW - 2 * DAY_MS),
      },
    ],
    details: [
      {
        id: 1,
        text: 'starts a new job on Monday',
        weight: 2,
        firstSeen: iso(NOW - 2 * DAY_MS),
        lastSeen: iso(NOW - 2 * DAY_MS),
      },
    ],
  };
  const request = buildRequest(
    await turnInput({
      history,
      trigger: history.at(-1),
      triggerKind: 'private',
      currentChannelId: 'dm1',
      privateChat: { userId: ANA },
      privateProfile,
      neighbors: [],
      lookup: null,
      descriptions: new Map(),
      videos: new Map(),
      reads: new Map(),
    })
  );
  const text = assertFilled(
    request.messages,
    { files: LOADS.private, blocks: ['senses', 'people', 'chat', 'tempo', 'task'] },
    'private'
  );
  assert.ok(text.includes(LABELS.senses.privateChat), 'the private senses line');
});

/**
 * #journal, a channel the persona reads but cannot write in, pulled into a turn in #général
 * (`reason`): Ana's lines, an earlier call answered, the last line a call when `called`.
 */
function diaryPulled(reason, { called = true } = {}) {
  const at = (minutes) => NOW - minutes * MINUTE_MS;
  const messages = normalize([
    rawMessage(DIARY_INFO, { ts: at(40), author: PEOPLE[ANA], content: 'journal du jour : semis' }),
    rawMessage(DIARY_INFO, { ts: at(30), author: PEOPLE[ANA], content: '@Zoë tu te souviens ?', mentions: [SELF_ID] }),
    rawMessage(DIARY_INFO, { ts: at(20), author: PEOPLE[ANA], content: 'et les tomates ?' }),
    rawMessage(DIARY_INFO, {
      ts: at(3),
      author: PEOPLE[ANA],
      content: called ? '@Zoë alors, ces tomates ?' : 'les tomates ont gelé',
      mentions: called ? [SELF_ID] : [],
    }),
  ]);
  const earlier = messages[1];
  return {
    channelId: DIARY,
    channelName: 'journal',
    readOnly: true,
    canReact: true,
    reason,
    earlierPingIds: new Set([earlier.id]),
    olderNotShown: true,
    descriptions: new Map(),
    picturesNotSeen: 2,
    pingState: new Map([[earlier.id, 'answered']]),
    newestId: messages.at(-1).id,
    newestTs: messages.at(-1).ts,
    messages,
  };
}

test('buildRequest: a routed call fills the task and renders the pulled channel with its call', async () => {
  const pulled = diaryPulled('routed');
  const call = pulled.messages.at(-1);
  const input = await turnInput({
    trigger: call,
    pulled: [pulled],
    source: { channelId: DIARY, reason: 'routed' },
    elsewhereDestination: { name: 'général' },
  });
  const request = buildRequest(input);
  const text = assertFilled(
    request.messages,
    { files: LOADS.routed, blocks: [...TURN_BLOCKS, 'channel_view'] },
    'routed'
  );
  const { timezone } = input.config.bot;
  for (const [key, line] of [
    ['elsewhere.called', fill(LABELS.elsewhere.called, { channel: 'journal', destination: 'général' })],
    ['senses.elsewhere', fill(LABELS.senses.elsewhere, { destination: 'général' })],
    ['server.readOnly', LABELS.server.readOnly],
    ['pull.olderNotShown', LABELS.pull.olderNotShown],
    ['pull.picturesNotSeen', fill(LABELS.pull.picturesNotSeen, { count: 2 })],
    [
      'pull.earlierPings',
      fill(LABELS.pull.earlierPings, { date: formatDate(pulled.messages[1].ts, timezone, LABELS.locale) }),
    ],
    ['pull.pingAnswered', LABELS.pull.pingAnswered],
  ]) {
    assert.ok(text.includes(line), `${key} is rendered`);
  }
});

test('buildRequest: a noticed turn fills elsewhere.md with the channel it read and the one it speaks in', async () => {
  const pulled = diaryPulled('noticed', { called: false });
  const request = buildRequest(
    await turnInput({
      mode: 'elsewhere',
      trigger: null,
      triggerKind: null,
      interlocutor: null,
      pulled: [pulled],
      source: { channelId: DIARY, reason: 'noticed' },
      elsewhereDestination: { name: 'général' },
    })
  );
  const text = assertFilled(
    request.messages,
    { files: LOADS.noticed, blocks: ['senses', 'channel_view', 'chat', 'tempo', 'task'] },
    'noticed'
  );
  assert.ok(!carries(text, 'reply') && !carries(text, 'interject'), 'the task is elsewhere.md alone');
});

test('buildDrawPrompt: draw.md and appearance.md are filled for a picture the persona is in', () => {
  const prompt = buildDrawPrompt({
    prompts: SHIPPED.prompts,
    selfName: SELF_NAME,
    request: 'the persona waters frozen tomatoes on a balcony',
    self: true,
  });
  assertFilled([{ role: 'user', content: prompt }], { files: LOADS.draw }, 'draw');
  const without = buildDrawPrompt({
    prompts: SHIPPED.prompts,
    selfName: SELF_NAME,
    request: 'a frozen balcony',
    self: false,
  });
  assertFilled([{ role: 'user', content: without }], { files: ['draw'] }, 'draw without the persona');
  const timed = buildDrawPrompt({
    prompts: SHIPPED.prompts,
    selfName: SELF_NAME,
    request: 'a frozen balcony',
    self: false,
    when: 'Mon 5 Oct, 23:10',
  });
  const text = assertFilled([{ role: 'user', content: timed }], { files: ['draw'] }, 'draw with the local time');
  assert.ok(text.includes(fill(LABELS.draw.when, { when: 'Mon 5 Oct, 23:10' })), 'draw.when fills {{when}}');
});

// ---- the diary ----------------------------------------------------------------------

/** Two past diary posts, one with a picture. */
const DIARY_POSTS = [
  { at: NOW - 2 * DAY_MS, kind: 'status', gist: 'pluie toute la journée', picture: null, messageIds: [], search: null },
  {
    at: NOW - DAY_MS,
    kind: 'selfPicture',
    gist: 'sur le toit',
    picture: 'a rooftop at dusk',
    messageIds: [],
    search: null,
  },
];

test('shipped labels: every kind of fact she can be told is worded, with no placeholder left unfilled, and the dropped-calls line takes its count and cause', () => {
  const facts = [
    { kind: 'callFailed', skill: 'web.search', status: 'failed', code: 'error', text: 'the page is gone' },
    { kind: 'doneWithoutDelivery', intentionId: 'i1', purpose: 'say hi' },
    { kind: 'loopCut', cut: 'extra-call', droppedCalls: 2, steps: 1 },
    {
      kind: 'wakeDropped',
      wakeId: 'w1',
      wake: 'intention_due',
      code: 'stale',
      why: 'done',
      intentionId: 'i1',
      purpose: 'say hi',
    },
    {
      kind: 'wakeDropped',
      wakeId: 'w2',
      wake: 'review',
      code: 'no-channel',
      why: 'no-review-channel',
      intentionId: null,
      purpose: '',
    },
    {
      kind: 'wakeHeld',
      wakeId: 'w3',
      wake: 'intention_due',
      code: 'per-chain',
      intentionId: 'i2',
      purpose: 'later',
      until: NOW + HOUR_MS,
    },
    { kind: 'turnFailed', code: 'cut-off', wake: 'attend' },
    { kind: 'sendFailed', code: 'forbidden', n: 1, total: 3 },
  ];
  const text = feedbackInTurnText(facts, LABELS, { locale: LABELS.locale });
  assert.equal(text.split('\n').length, facts.length + 1, text);
  assert.equal(text.split('\n')[0], LABELS.wake.feedbackInTurn);
  assert.ok(!/[{}]/.test(text), text);
  for (const code of [
    'done',
    'cancelled',
    'expired',
    'forgotten',
    'dm-off',
    'not-writable',
    'unavailable',
    'no-review-channel',
  ])
    assert.equal(typeof LABELS.wake.feedback.codes[code], 'string', code);
  assert.equal(fill(LABELS.task.callsDropped, { count: '2', why: 'extra-call' }).includes('{'), false);
});

test('buildRequest: an inner turn fills system-prompt, character-card, rules, format, inner.md and every labels.wake line', async () => {
  const resetAt = NOW + 12 * HOUR_MS;
  const wake = {
    kind: 'intention_due',
    items: [
      { kind: 'intention_due', intentionIds: ['i1'] },
      { kind: 'errand_deadline', intentionIds: ['i2'], errandId: 'T1' },
      { kind: 'review', intentionIds: [] },
    ],
    intentions: [
      { id: 'i1', purpose: 'ask Ana how the tomatoes are doing', dueAt: NOW - HOUR_MS },
      { id: 'i2', purpose: 'share what the errand found', dueAt: null },
    ],
    now: NOW,
    timezone: 'UTC',
    channels: ['général'],
    budgets: {
      day: { left: 20, cap: 24, resetAt },
      hour: { left: 3, cap: 4, resetAt: NOW + HOUR_MS },
      chain: { left: 2, cap: 3 },
      posts: { left: 2, cap: 2, resetAt },
    },
  };
  const request = buildRequest(
    await turnInput({
      mode: 'inner',
      trigger: null,
      triggerKind: 'inner',
      interlocutor: null,
      wake: wakeBlockText(wake, LABELS, { locale: LABELS.locale }),
    })
  );
  const text = assertFilled(request.messages, { files: LOADS.inner, blocks: ['wake', 'chat', 'task'] }, 'inner turn');
  assert.ok(text.includes(LABELS.wake.header));
  assert.ok(text.includes('ask Ana how the tomatoes are doing'));
});

test('buildRequest: an inner turn woken by a heartbeat fills heartbeat.md in place of inner.md; a review keeps inner.md', async () => {
  const beat = await turnInput({
    mode: 'inner',
    trigger: null,
    triggerKind: 'inner',
    interlocutor: null,
    wake: '',
    wakeKind: 'heartbeat',
  });
  const beatRequest = buildRequest(beat);
  const beatText = assertFilled(beatRequest.messages, { files: LOADS.heartbeat, blocks: ['task'] }, 'heartbeat turn');
  assert.ok(
    !/^<chat>\s*$/m.test(userText(beatRequest.messages[1].content)),
    'a heartbeat has no current conversation to answer'
  );
  assert.ok(
    !/^<tempo>\s*$/m.test(userText(beatRequest.messages[1].content)),
    'silence in an anchor channel is not heartbeat tempo'
  );
  assert.ok(!carries(beatText, 'inner'), 'inner.md is not sent as well');
  const review = await turnInput({
    mode: 'inner',
    trigger: null,
    triggerKind: 'inner',
    interlocutor: null,
    wake: '',
    wakeKind: 'review',
  });
  const reviewText = assertFilled(
    buildRequest(review).messages,
    { files: LOADS.inner, blocks: ['chat', 'task'] },
    'review turn'
  );
  assert.ok(!carries(reviewText, 'heartbeat'), 'heartbeat.md is not sent on a review');
  const missing = await turnInput({
    mode: 'inner',
    trigger: null,
    triggerKind: 'inner',
    interlocutor: null,
    wake: '',
    wakeKind: 'heartbeat',
  });
  missing.prompts = { ...SHIPPED.prompts, heartbeat: '  ' };
  assertFilled(buildRequest(missing).messages, { files: LOADS.inner }, 'heartbeat with no heartbeat.md');
});

test('buildRequest: a diary post fills system-prompt, character-card, rules, format, diary.md and world.md', async () => {
  const input = await turnInput({
    mode: 'diary',
    trigger: null,
    triggerKind: null,
    interlocutor: null,
    currentChannelId: DIARY,
  });
  input.config = shippedConfig({ diary: { world: true, channelId: DIARY } });
  const plan = { kind: 'selfPicture', brief: 'a pier in the fog', picture: true };
  const request = buildRequest({
    ...input,
    diaryChannel: 'journal',
    diary: { posts: DIARY_POSTS, plan, found: 'Une comète passe ce soir.' },
  });
  const text = assertFilled(
    request.messages,
    { files: LOADS.diary, blocks: ['senses', 'world', 'diary', 'plan', 'found', 'chat', 'task'] },
    'diary'
  );
  assert.ok(text.includes(fill(LABELS.senses.diary, { channel: 'journal' })), 'senses.diary names the channel');
});

test('buildDiaryPlanRequest: diary-plan.md and world.md fill the plan request with its blocks', async () => {
  const config = shippedConfig({ diary: { world: true, channelId: DIARY } });
  const seeds = renderSeedsBlock(
    pickSeeds(parseSeedFamilies(SHIPPED.prompts['diary-seeds']), config.diary.seedSets, () => 0.5),
    LABELS
  );
  const request = buildDiaryPlanRequest({
    config,
    prompts: SHIPPED.prompts,
    calibrator: createCalibrator(),
    now: NOW,
    selfName: SELF_NAME,
    history: [],
    guildMemory: GUILD_MEMORY,
    channels: CHANNELS,
    loreEntries: LORE,
    currentChannelId: DIARY,
    recentLines: RECENT_LINES,
    recentAudience: () => true,
    candidateProfiles: Object.values(PROFILES),
    nameOf,
    posts: DIARY_POSTS,
    kinds: config.diary.kinds,
    seedsText: seeds,
  });
  assertFilled(
    request.messages,
    { files: LOADS.diaryPlan, blocks: ['now', 'server', 'about_chat', 'world', 'diary', 'kinds', 'seeds'] },
    'diary plan'
  );
});

// ---- the Discord fakes ---------------------------------------------------------------------

/** A discord.js-shaped text channel of `guild`: its history newest first on fetch, every permission granted. */
function discordChannel(guild, info, raws) {
  const newestFirst = [...raws].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  const channel = {
    id: info.id,
    name: info.name,
    parent: info.category ? { name: info.category } : null,
    topic: info.topic,
    guild,
    viewable: true,
    lastMessageId: newestFirst[0]?.id ?? null,
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    sendTyping: async () => {},
    send: async () => {
      throw new Error('nothing is sent in these tests');
    },
    messages: {
      cache: new Map(),
      fetch: async (query = {}) => {
        if (typeof query === 'string') throw new Error(`no single message fetch here: ${query}`);
        let pool = newestFirst;
        if (query.before) pool = pool.filter((m) => BigInt(m.id) < BigInt(query.before));
        return new Map(pool.slice(0, query.limit ?? 50).map((m) => [m.id, m]));
      },
    },
  };
  for (const raw of raws) raw.channel = channel;
  return channel;
}

/** A guild holding one channel per `[info, raws]`, the persona its member. */
function discordGuild(channels) {
  const guild = { id: GUILD, members: { me: { displayName: SELF_NAME } }, channels: { cache: new Map() } };
  for (const [info, raws] of channels) guild.channels.cache.set(info.id, discordChannel(guild, info, raws));
  return guild;
}

/** The guild of a message the pipeline reads: its id and the persona's name there. */
const MESSAGE_GUILD = { id: GUILD, members: { me: { displayName: SELF_NAME } } };

/** A fake `llm.complete` recording every request and answering `answer(messages, options)`. */
function recordingLlm(answer) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options = {}) => {
      calls.push({ messages, options, text: requestText(messages) });
      const text = await answer(messages, options);
      return { text, usage: { prompt_tokens: 100, completion_tokens: 10 }, estimated: 100, finishReason: 'stop' };
    },
  };
}

test('createTurnRunner: a reply turn fills the describer, re-watch, link, search, recall and turn requests', async () => {
  const hot = shippedHot({ features: { webLookup: true, videoDescriptions: true } });
  // An old line of #jardin the server search finds (the turn's own chat is never a hit).
  const old = rawMessage(GARDEN_INFO, {
    ts: NOW - 4 * DAY_MS,
    author: PEOPLE[NIKOS],
    content: 'la tomate a gelé cette nuit',
  });
  const guild = discordGuild([
    [GENERAL_INFO, generalRaws()],
    [GARDEN_INFO, [old]],
  ]);
  const hit = {
    id: old.id,
    channel_id: GARDEN,
    timestamp: iso(old.createdTimestamp),
    author: { id: NIKOS, username: 'Nikos', global_name: 'Nikos', bot: false },
    content: old.content,
  };
  guild.client = {
    rest: {
      get: async (route) =>
        route.endsWith('/messages/search') ? { total_results: 1, messages: [[{ ...hit, hit: true }]] } : [],
    },
  };
  const channels = worldChannelsOf([
    [GENERAL_INFO, generalRaws()],
    [GARDEN_INFO, [old]],
  ]);
  const channel = channels[GENERAL];
  const mediaCache = {};
  const state = { data: {}, markDirty() {} };
  const store = {
    state,
    getGuild: () => GUILD_MEMORY,
    getUser: (guildId, id) => PROFILES[id] ?? null,
    getPrivate: () => null,
    listUserProfiles: () => Object.values(PROFILES),
    listChannels: () => CHANNELS,
    getLore: () => LORE,
    getMediaCache: () => mediaCache,
    markMediaCacheDirty() {},
    getGifs: () => ({ nextId: 1, entries: {} }),
    getRecent: () => ({ lines: RECENT_LINES }),
  };
  // Which prompt a request was built from, by the text of its system message.
  const kinds = [
    'describe-gif',
    'describe-video',
    'rewatch-answer',
    'describe',
    'rewatch',
    'read-link',
    'lookup',
    'search-summary',
    'recall-summary',
    'system-prompt',
  ];
  const answers = {
    'describe-gif': 'a cat waves at the camera',
    'describe-video': 'a person juggles three oranges in a kitchen',
    'rewatch-answer': 'all three oranges are bright orange',
    describe: 'a tomato plant covered in frost',
    rewatch: '1 | what colour are the oranges?',
    'read-link': 'How to grow tomatoes in pots on a balcony, with watering and frost advice.',
    lookup: 'web: tomato frost date\nserver: tomate, gelé',
    'search-summary': 'Tomatoes die below zero degrees [1].',
    'recall-summary': 'stretch: 1\nNikos said in #jardin four days ago that the tomato froze.',
    'system-prompt': '<skip/>',
  };
  const kindOf = (messages) => kinds.find((name) => carries(contentText(messages[0].content), name)) ?? null;
  const llm = recordingLlm((messages) => answers[kindOf(messages)] ?? '');
  const imageFetcher = {
    fetchAsDataUrl: async () => ({ dataUrl: 'data:image/webp;base64,ZmFrZQ==', bytes: 4, contentType: 'image/webp' }),
  };
  const clip = { ok: true, dataUrl: 'data:video/mp4;base64,AAAA', seconds: 20, bytes: 1000 };
  const videoFetcher = {
    fetchAttachment: async () => clip,
    fetchGif: async () => ({ ...clip, seconds: 3 }),
    fetchSiteClip: async () => ({ ok: false, reason: 'error' }),
    probeSite: async () => ({ ok: false, reason: 'error' }),
    probeYoutube: async () => ({ ok: false, reason: 'error' }),
  };
  const describer = createDescriber({ hot, store, llm, now: () => NOW, imageFetcher, videoFetcher, state });
  const pageFetcher = {
    fetchText: async () => ({
      ok: true,
      title: 'Tomates en pot',
      text: 'Tomatoes grow well in pots. Water them often. Bring them in before the frost.',
    }),
  };
  const braveSearch = {
    search: async () => ({
      ok: true,
      results: [
        { title: 'Garden notes', url: 'https://www.example.com/frost', snippet: 'frost kills tomatoes', age: '2 days' },
      ],
    }),
  };
  const lookup = createLookup({
    hot,
    store,
    llm,
    state,
    pageFetcher,
    searches: { brave: braveSearch },
    keys: { brave: 'test-key' },
    now: () => NOW,
  });
  const recall = createRecall({ reads: world().reads, hot, store, llm, describer, now: () => NOW });
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: createCalibrator(),
    describer,
    lookup,
    recall,
    imageFetcher,
    fetchImpl: previewFetch,
    now: () => NOW,
    rng: () => 0.5,
  });

  const history = await generalHistory();
  const { result } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: history.at(-1), triggerKind: 'mention' })
  );
  assert.equal(result.outcome, 'skip', 'the turn ran to its answer');

  const expected = [
    ['describe', LOADS.describe],
    ['describe-gif', LOADS.describeGif],
    ['describe-video', LOADS.describeVideo],
    ['rewatch', LOADS.rewatch],
    ['rewatch-answer', LOADS.rewatchAnswer],
    ['read-link', LOADS.readLink],
    ['lookup', LOADS.lookup],
    ['search-summary', LOADS.searchSummary],
    ['recall-summary', LOADS.recallSummary],
  ];
  for (const [kind, files] of expected) {
    const calls = llm.calls.filter((call) => kindOf(call.messages) === kind);
    assert.ok(calls.length > 0, `no ${kind} request was sent`);
    for (const call of calls) assertFilled(call.messages, { files }, kind);
  }
  const [summary] = llm.calls.filter((call) => kindOf(call.messages) === 'recall-summary');
  // `<memory>`: the stored lore entry keyed `tomate` matches the form `tomate`.
  assertFilled(
    summary.messages,
    { files: LOADS.recallSummary, blocks: ['memory', 'found', 'question'] },
    'recall-summary'
  );
  const [turn] = llm.calls.filter((call) => kindOf(call.messages) === 'system-prompt');
  const text = assertFilled(
    turn?.messages,
    {
      files: LOADS.turn,
      blocks: ['senses', 'about_chat', 'server', 'lore', 'people', 'lookup', 'chat', 'tempo', 'task'],
    },
    'the turn'
  );
  // Both parts of <lookup>, with the stretch the summary named.
  for (const key of ['bothNote', 'webHeader', 'serverHeader'])
    assert.ok(text.includes(LABELS.lookup[key]), `the turn: no labels.lookup.${key}`);
  assert.ok(
    text.includes(
      fill(LABELS.lookup.stretch, {
        date: zonedDay(old.createdTimestamp, SHIPPED.config.bot.timezone),
        channel: 'jardin',
      })
    )
  );
});

test('createChannelRouter: the route classifier fills route-channel.md', async () => {
  const hot = shippedHot();
  const channels = worldChannelsOf([
    [GENERAL_INFO, generalRaws()],
    [GARDEN_INFO, []],
    [DIARY_INFO, []],
  ]);
  const store = { listChannels: () => CHANNELS, getUser: (guildId, id) => PROFILES[id] ?? null };
  const llm = recordingLlm(() => 'none');
  const router = createChannelRouter({ hot, store, llm, now: () => NOW });
  const history = await generalHistory();
  const snapshot = await takeSnapshot(world().reads, GUILD);
  const { result } = await withCapturedLogs(() =>
    router({
      guildId: GUILD,
      channel: channels[GENERAL].info,
      snapshot,
      history,
      trigger: history.at(-1),
      triggerKind: 'mention',
      selfName: SELF_NAME,
      config: hot.config,
    })
  );
  assert.deepEqual(result, []);
  assert.equal(llm.calls.length, 1, 'one route request');
  assertFilled(
    llm.calls[0].messages,
    { files: LOADS.routeChannel, blocks: ['transcript', 'channels', 'candidate'] },
    'route-channel'
  );
});

/** The persona's stored exchanges: one in #jardin and one in #journal, both inside the window. */
function participationState() {
  const own = (id, ts, text) => ({
    id,
    ts,
    authorId: SELF_ID,
    name: SELF_NAME,
    self: true,
    text,
    replyTo: null,
    caption: null,
  });
  const member = (id, ts, text) => ({
    id,
    ts,
    authorId: NIKOS,
    name: 'Nikos',
    self: false,
    text,
    replyTo: null,
    caption: 'a tomato plant',
  });
  return {
    nextId: 3,
    episodes: [
      {
        id: 'p1',
        channelId: GARDEN,
        continues: null,
        messages: [
          member('pa1', NOW - 3 * 60 * MINUTE_MS, 'les tomates ont poussé'),
          own('pa2', NOW - 3 * 60 * MINUTE_MS + MINUTE_MS, 'enfin !'),
        ],
      },
      {
        id: 'p2',
        channelId: DIARY,
        continues: null,
        messages: [own('pb1', NOW - 40 * MINUTE_MS, 'je relis mes notes')],
      },
    ],
  };
}

test('createParticipationPicker: the pick classifier fills participation-pick.md', async () => {
  const hot = shippedHot();
  const channels = worldChannelsOf([
    [GENERAL_INFO, generalRaws()],
    [GARDEN_INFO, []],
    [DIARY_INFO, []],
  ]);
  const store = { getParticipation: () => participationState(), listChannels: () => CHANNELS };
  const llm = recordingLlm(() => 'none');
  const picker = createParticipationPicker({ hot, store, llm, now: () => NOW });
  const history = await generalHistory();
  const snapshot = await takeSnapshot(world().reads, GUILD);
  const { result } = await withCapturedLogs(() =>
    picker({
      guildId: GUILD,
      channel: channels[GENERAL].info,
      snapshot,
      history,
      trigger: history.at(-1),
      triggerKind: 'mention',
      mode: 'reply',
      selfName: SELF_NAME,
      audience: () => true,
    })
  );
  assert.deepEqual(result, []);
  assert.equal(llm.calls.length, 1, 'one pick request');
  assertFilled(
    llm.calls[0].messages,
    { files: LOADS.participationPick, blocks: ['transcript', 'candidate', 'episodes'] },
    'participation-pick'
  );
});

test('askPlanner: the turn planner fills planner.md', async () => {
  const hot = shippedHot();
  const llm = recordingLlm(() => 'channel: none\nepisodes: none\nrewatch: none\nlookup: none');
  const { result } = await withCapturedLogs(() =>
    askPlanner({
      llm,
      config: hot.config,
      prompt: hot.prompts.planner,
      selfName: SELF_NAME,
      today: zonedDay(NOW, hot.config.bot.timezone),
      offer: {
        channels: ['1 | #jardin | Nikos | the garden'],
        episodes: ['1 | #journal | 40 min |  | Zoë: je relis mes notes'],
        media: ['1 | video | clip.mp4 | watched | a tomato plant'],
        lookup: true,
      },
      transcriptBlock: '<transcript>\nNikos: les tomates ont poussé\n</transcript>\n',
      candidateBlock: '<candidate>\nAna: tu te souviens ?\n</candidate>',
      now: () => NOW,
    })
  );
  assert.equal(result.outcome, 'classified');
  assert.equal(llm.calls.length, 1, 'one planner request');
  assertFilled(
    llm.calls[0].messages,
    { files: LOADS.planner, blocks: ['channels', 'episodes', 'media', 'transcript', 'candidate'] },
    'planner'
  );
});

test('buildRequest: the <participation> block fills its labels and the senses line', async () => {
  const request = buildRequest(
    await turnInput({
      participation: { state: participationState(), pickedIds: [], audience: () => true, channelName: () => null },
    })
  );
  const text = assertFilled(
    request.messages,
    { files: LOADS.reply, blocks: [...TURN_BLOCKS, 'participation'] },
    'participation'
  );
  assert.ok(text.includes(LABELS.senses.participation), 'senses.participation rides with the block');
  assert.ok(text.indexOf('<participation>') < text.indexOf('<other_channels>'));
});

test('createMessageHandler: the room classifier fills room.md', async () => {
  const hot = shippedHot({ memory: { mainChannelIds: [GENERAL] } });
  worldChannelsOf([[GENERAL_INFO, generalRaws()]]);
  // An untagged line put to everyone, outside any follow-up window; its author has a stored alias.
  const line = rawMessage(GENERAL_INFO, {
    ts: NOW - MINUTE_MS,
    author: PEOPLE[NIKOS],
    content: 'qui vient au marché samedi ?',
  });
  Object.assign(line, { guild: MESSAGE_GUILD, system: false, webhookId: null });
  const store = { state: { data: {}, markDirty() {} }, getUser: (guildId, id) => PROFILES[id] ?? null };
  const turns = {
    notePost() {},
    runTurn: async () => ({ outcome: 'skip' }),
    isBusy: () => false,
    isAnyBusy: () => false,
    lastPostAt: () => 0,
  };
  const scheduled = [];
  // The eavesdrop roll lost, its rails pass: the room path is next.
  const spontaneous = {
    onMessage: (...args) => {
      scheduled.push(args);
      return false;
    },
    eavesdropReady: () => true,
  };
  const llm = recordingLlm(() => 'yes');
  const handler = createMessageHandler({
    hot,
    store,
    reads: world().reads,
    selfId: () => SELF_ID,
    port: world().port,
    turns,
    spontaneous,
    memory: { observe() {} },
    tagHistory: createTagHistory(),
    getGuildId: () => GUILD,
    getSelfName: () => SELF_NAME,
    llm,
    rng: () => 0,
    now: () => NOW,
  });

  await withCapturedLogs(() => handler(onWorldIface(toEvent(line, SELF_ID, normalizeOptions(hot.config)))));

  assert.equal(llm.calls.length, 1, 'one room request');
  assertFilled(llm.calls[0].messages, { files: LOADS.room, blocks: ['author', 'candidate'] }, 'room');
  assert.equal(llm.calls[0].options.purpose, 'room');
  assert.deepEqual(scheduled.at(-1)?.[2], { room: true }, 'the yes reached the scheduler');
});

// ---- several requests in one message, several calls waiting ------------------------------

const SPLIT_LINE =
  'Zoë, trois choses : qui a planté les tomates, regarde le canal du jardin, et dis-moi si la photo est drôle.';

/** The store a turn reads, empty but for the state: the split tests look at the task labels only. */
function bareStore() {
  return {
    state: { data: {}, markDirty() {} },
    getGuild: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listUserProfiles: () => [],
    listChannels: () => [],
    getLore: () => [],
    getMediaCache: () => ({}),
  };
}

test('createTurnRunner: the splitter fills split.md; each part, its queued calls and a folded message fill labels.task', async () => {
  const hot = shippedHot({ features: { typingSimulation: false } });
  const line = rawMessage(GENERAL_INFO, {
    ts: NOW - MINUTE_MS,
    author: PEOPLE[ANA],
    content: SPLIT_LINE,
    mentions: [SELF_ID],
  });
  const channel = worldChannelsOf([[GENERAL_INFO, [...generalRaws(), line]]])[GENERAL];
  const llm = recordingLlm((messages, options) =>
    options.purpose === 'split' ? '- qui a planté les tomates\n- regarde le canal du jardin' : '<skip/>'
  );
  const turns = createTurnRunner({
    hot,
    store: bareStore(),
    llm,
    calibrator: createCalibrator(),
    now: () => NOW,
    rng: () => 0.5,
  });
  const history = normalize([...generalRaws(), line]);
  const trigger = history.at(-1);
  const queued = () => [{ id: 'q1', text: 'et la photo ?' }];
  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention', queued }));

  const [split] = llm.calls.filter((call) => call.options.purpose === 'split');
  assertFilled(split?.messages, { files: LOADS.split, blocks: ['transcript', 'candidate'] }, 'split');
  const parts = llm.calls.filter((call) => call.options.purpose === 'reply');
  assert.equal(parts.length, 2, 'one turn per part');
  for (const [i, call] of parts.entries()) {
    const text = assertFilled(call.messages, { files: LOADS.reply, blocks: ['chat', 'task'] }, `part ${i + 1}`);
    assert.ok(text.includes(LABELS.task.part.split('{')[0]), `part ${i + 1}: labels.task.part`);
    assert.ok(text.includes('3. et la photo ?'), `part ${i + 1}: the queued call follows the parts`);
  }

  // A turn with no part: its author's queued calls under labels.task.queued, a folded message under labels.task.added.
  const plainLlm = recordingLlm(() => '<skip/>');
  const plain = createTurnRunner({
    hot,
    store: bareStore(),
    llm: plainLlm,
    calibrator: createCalibrator(),
    now: () => NOW,
    rng: () => 0.5,
  });
  const short = history.at(-2);
  await withCapturedLogs(() =>
    plain.runTurn({
      channel,
      mode: 'reply',
      trigger: short,
      triggerKind: 'mention',
      queued,
      added: [{ id: 'f1', text: 'alors ?', ts: NOW }],
    })
  );
  const reply = plainLlm.calls.find((call) => call.options.purpose === 'reply');
  const text = assertFilled(reply?.messages, { files: LOADS.reply, blocks: ['task'] }, 'queued and added');
  assert.ok(text.includes(fill(LABELS.task.queued, { others: '1. et la photo ?' })));
  assert.ok(text.includes(fill(LABELS.task.added, { added: 'alors ?' })));
});

// ---- the GIF picker ---------------------------------------------------------------------

test('createTurnRunner: the GIF picker fills gif-pick.md', async () => {
  const hot = shippedHot({ features: { typingSimulation: false } });
  const line = rawMessage(GENERAL_INFO, {
    ts: NOW - MINUTE_MS,
    author: PEOPLE[ANA],
    content: 'Zoë, tu viens ce soir ?',
    mentions: [SELF_ID],
  });
  const channel = worldChannelsOf([[GENERAL_INFO, [...generalRaws(), line]]])[GENERAL];
  const gifs = {
    nextId: 3,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: 'https://tenor.com/view/chat-qui-danse-1',
        itemId: 'gif-item-1',
        messageId: 'm1',
        channelId: GENERAL,
        count: 3,
        last: NOW - HOUR_MS,
      },
      k2: {
        id: 'g2',
        kind: 'link',
        url: 'https://tenor.com/view/haussement-2',
        itemId: 'gif-item-2',
        messageId: 'm2',
        channelId: GENERAL,
        count: 1,
        last: NOW - DAY_MS,
        ownLast: NOW - HOUR_MS,
      },
    },
  };
  const mediaCache = { 'gif-item-1': { text: 'un chat qui danse' }, 'gif-item-2': { text: "un haussement d'épaules" } };
  const llm = recordingLlm((messages, options) =>
    options.purpose === 'gif-pick' ? 'none' : '<msg>oui, bien sûr</msg>'
  );
  const store = { ...bareStore(), getMediaCache: () => mediaCache, getGifs: () => gifs, findGif: () => null };
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: createCalibrator(),
    now: () => NOW,
    rng: () => 0.5,
  });
  const history = normalize([...generalRaws(), line]);
  await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: history.at(-1), triggerKind: 'mention' })
  );

  const [pick] = llm.calls.filter((call) => call.options.purpose === 'gif-pick');
  const text = assertFilled(
    pick?.messages,
    { files: LOADS.gifPick, blocks: ['context', 'reply', 'gifs', 'gifs_recent'] },
    'gif-pick'
  );
  assert.ok(text.includes(SELF_NAME), 'gif-pick: {{name}} is the persona');
  assert.ok(
    text.includes(fill(LABELS.gifs.entry, { id: 'g1', text: 'un chat qui danse' })),
    'gif-pick: an entry through labels.gifs.entry'
  );
  assert.ok(
    text.includes(`g2 ${fill(LABELS.gifs.ownMark, { ago: `1 ${LABELS.units.hour}` })}`),
    'gif-pick: the own post in <gifs_recent> through labels.gifs.ownMark'
  );
});

test('createMissed: the missed-answer check fills missed.md', async () => {
  const history = await generalHistory();
  const candidate = history.findLast((message) => !message.self);
  const llm = recordingLlm(() => '1: stale');
  worldChannelsOf([[GENERAL_INFO, generalRaws()]]);
  const dataDir = tempDir('nep-shipped-missed-');
  const missed = createMissed({
    hot: shippedHot(),
    store: { state: { data: {} } },
    llm,
    turns: { triggerOf: () => null },
    reads: world().reads,
    iface: () => world().port.iface,
    getGuildId: () => GUILD,
    getSelfName: () => SELF_NAME,
    dataDir,
    now: () => candidate.ts + MINUTE_MS,
    timers: { set: () => null, clear() {} },
  });
  try {
    await withCapturedLogs(async () => {
      missed.noteFact({ reason: 'gate-failed', message: candidate });
      await missed.sweep(GENERAL);
    });
    assert.equal(llm.calls.length, 1, 'one check for the channel');
    assertFilled(llm.calls[0].messages, { files: LOADS.missed, blocks: ['candidates'] }, 'missed');
    assert.equal(llm.calls[0].options.purpose, 'missed');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('buildRequest: a recovery turn names its messages under labels.task.missed and its trigger label', async () => {
  const tasks = {
    part: null,
    queued: [],
    queuedOthers: [],
    added: [],
    missed: [{ author: 'Ana', text: 'tu es là ?' }],
  };
  const request = buildRequest(await turnInput({ triggerKind: 'missed', tasks }));
  const text = assertFilled(request.messages, { files: LOADS.reply, blocks: TURN_BLOCKS }, 'reply (missed)');
  assert.ok(text.includes(LABELS.triggers.missed), 'the trigger label fills {{trigger}}');
  assert.ok(text.includes(fill(LABELS.task.missed, { missed: '1. Ana: tu es là ?' })), 'the task names the messages');
});

test('createMessageHandler: the merge classifier fills merge.md', async () => {
  const hot = shippedHot();
  worldChannelsOf([[GENERAL_INFO, generalRaws()]]);
  const line = rawMessage(GENERAL_INFO, {
    ts: NOW - MINUTE_MS,
    author: PEOPLE[ANA],
    content: 'alors, le canal ?',
    mentions: [SELF_ID],
  });
  Object.assign(line, { guild: MESSAGE_GUILD, system: false, webhookId: null });
  const folded = [];
  // She is busy with Ana's split message: its second part still waits.
  const turns = {
    notePost() {},
    runTurn: async () => ({ outcome: 'skip' }),
    isBusy: () => false,
    isAnyBusy: () => true,
    lastPostAt: () => 0,
    waitingParts: () => [{ index: 2, text: 'regarde le canal du jardin' }],
    addToPart: (...args) => folded.push(args) > 0,
  };
  const llm = recordingLlm(() => '1');
  const handler = createMessageHandler({
    hot,
    store: { state: { data: {}, markDirty() {} }, getUser: () => null },
    reads: world().reads,
    selfId: () => SELF_ID,
    port: world().port,
    turns,
    spontaneous: { onMessage: () => false },
    memory: { observe() {} },
    tagHistory: createTagHistory(),
    getGuildId: () => GUILD,
    getSelfName: () => SELF_NAME,
    llm,
    rng: () => 0.5,
    now: () => NOW,
    sleep: async () => {},
  });

  await withCapturedLogs(async () => {
    await handler(onWorldIface(toEvent(line, SELF_ID, normalizeOptions(hot.config))));
    for (let i = 0; i < 20 && folded.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
  });

  assert.equal(llm.calls.length, 1, 'one merge request');
  assertFilled(llm.calls[0].messages, { files: LOADS.merge, blocks: ['waiting', 'candidate'] }, 'merge');
  assert.equal(llm.calls[0].options.purpose, 'merge');
  assert.equal(folded.length, 1, 'folded into the waiting part');
});

test('createAvatarQueue: the avatar describer fills avatar.md', async () => {
  const hot = shippedHot({ features: { avatars: true } });
  const profile = { id: 'u1', names: ['Ελένη'] };
  const store = {
    getUser: (guildId, id) => (id === 'u1' ? profile : null),
    listUserProfiles: () => [profile],
    setAvatar: (guildId, id, avatar) => Object.assign(profile, { avatar }),
  };
  const llm = recordingLlm(() => 'an illustrated fox in a scarf');
  const imageFetcher = {
    fetchAsDataUrl: async () => ({ dataUrl: 'data:image/png;base64,ZmFrZQ==', bytes: 4, contentType: 'image/png' }),
  };
  const state = { data: {}, markDirty() {} };
  const view = { id: 'u1', bot: false, hash: 'h1', url: 'https://cdn.example/avatars/u1/h1.png?size=256' };
  const queue = createAvatarQueue({
    hot,
    store,
    llm,
    imageFetcher,
    state,
    getGuildId: () => GUILD,
    selfId: () => SELF_ID,
    // The interface answers `memberInfo` with the member and the hash and address of their avatar.
    reads: {
      memberInfo: async () => ({
        member: {
          id: view.id,
          name: null,
          bot: view.bot,
          groupIds: [],
          avatar: { hash: view.hash, url: view.url, largeUrl: null },
        },
      }),
    },
    now: () => NOW,
  });
  const { result } = await withCapturedLogs(() => queue.tick());
  assert.equal(result, 'described');
  assert.equal(llm.calls.length, 1);
  assertFilled(llm.calls[0].messages, { files: LOADS.avatar }, 'avatar');
  assert.equal(profile.avatar.text, 'an illustrated fox in a scarf');
});
