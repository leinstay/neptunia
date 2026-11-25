// Tests for src/behavior/split.ts: the cheap pre-filter in front of the splitter, its settings and
// the strict parse of its answer. Every behaviour test sets its own settings.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { foldShortParts, mayHaveParts, parseSplitAnswer, splitCandidate } from '../../../src/behavior/split.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowflakeUtil } from 'discord.js';
import { joinLabels } from '../../../src/config/labels.ts';
import { deepMerge } from '../../../src/config.ts';
import { MINUTE_MS } from '../../../src/time.ts';
import { fill } from '../../../src/format.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { normalizeMessage } from '../../../interfaces/discord/index.ts';
import { onWorld, worldChannels, useIface, useSelf } from '../../fixtures/turn-world.ts';
import { createCalibrator } from '../../../src/llm/tokens.ts';
import type { labels as contractLabels } from '../../fixtures/labels.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { SPLIT_PARTS, splitLlm, runSplitTurn, partLabel, taskOf } from '../../fixtures/turn-split.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

const SETTINGS = { minChars: 40, maxTasks: 3, contextMessages: 2, maxOutputTokens: 100 };
const config = (split = SETTINGS) => ({ split });
const LONG = 'πρώτα πες μου ποιος είναι ο Νίκος, μετά κοίτα το κανάλι της Ελένης; και το μιμίδιο είναι αστείο.';

test('mayHaveParts: long text with two separators passes', () => {
  assert.equal(mayHaveParts(LONG, 40), true);
});

test('mayHaveParts: text under minChars never passes', () => {
  assert.equal(mayHaveParts('ποιος, τι; πού.', 40), false);
});

test('mayHaveParts: long text with fewer than two separators does not pass', () => {
  assert.equal(mayHaveParts('a'.repeat(60), 40), false);
  assert.equal(mayHaveParts(`${'b'.repeat(60)}?`, 40), false);
});

test('mayHaveParts: a run of separators counts once', () => {
  assert.equal(mayHaveParts(`${'c'.repeat(60)}?!...`, 40), false);
  assert.equal(mayHaveParts(`${'c'.repeat(30)}?! ${'d'.repeat(30)}.`, 40), true);
});

test('mayHaveParts: line breaks and semicolons are separators', () => {
  assert.equal(mayHaveParts(`${'e'.repeat(30)}\n${'f'.repeat(30)}; g`, 40), true);
});

test('mayHaveParts: links and Discord tokens neither count toward length nor bring separators', () => {
  const linkOnly = 'https://www.example.com/a.b.c?d=1,2;3 <@123456789012345678> <#123456789012345679>';
  assert.equal(mayHaveParts(linkOnly, 40), false);
});

test('splitCandidate: a direct call of every kind with structured text is a candidate', () => {
  // `split` runs for every started turn, an overheard one included.
  for (const kind of ['mention', 'reply', 'followUp', 'overheard', 'private']) {
    assert.equal(splitCandidate({ content: LONG }, kind, config()), true, kind);
  }
});

// A missed-answer recovery does not split.
test('splitCandidate: a missed-answer recovery and an unprompted turn never are', () => {
  assert.equal(splitCandidate({ content: LONG }, 'missed', config()), false);
  assert.equal(splitCandidate(null, null, config()), false);
});

test('parseSplitAnswer: the word one is one request', () => {
  assert.deepEqual(parseSplitAnswer('{"parts":[]}', 3), { parts: null, reason: 'one' });
  assert.deepEqual(parseSplitAnswer('  {"parts":["κοίτα το κανάλι"]} \n', 3), { parts: null, reason: 'one' });
});

test('parseSplitAnswer: dash lines are the parts, whitespace collapsed', () => {
  assert.deepEqual(parseSplitAnswer(JSON.stringify({ parts: ['ποιος είναι ο Νίκος', '  κοίτα  το κανάλι\n'] }), 3), {
    parts: ['ποιος είναι ο Νίκος', 'κοίτα το κανάλι'],
    reason: 'parts',
  });
});

test('parseSplitAnswer: more parts than maxTasks are cut', () => {
  assert.deepEqual(parseSplitAnswer('{"parts":["a","b","c","d"]}', 3).parts, ['a', 'b', 'c']);
});

test('parseSplitAnswer: anything else is one request, unparsed', () => {
  for (const text of [
    '- only one part',
    'two\n- a\n- b',
    '- a\nmore text\n- b',
    '1. a\n2. b',
    '-a\n-b',
    '- a\n- ',
    'yes',
  ]) {
    assert.deepEqual(parseSplitAnswer(text, 3), { parts: null, reason: 'unparsed' }, JSON.stringify(text));
  }
});

test('parseSplitAnswer: an empty or missing answer is empty', () => {
  assert.deepEqual(parseSplitAnswer('  \n', 3), { parts: null, reason: 'empty' });
  assert.deepEqual(parseSplitAnswer(undefined, 3), { parts: null, reason: 'empty' });
});

const OPENER = 'θα έχει μειονεκτήματα;';
const ARGUMENT = 'αφού ο καθένας ζει μόνος του και κανείς δεν φταίει';
const CLOSER = 'τι μπορεί να κάνει λοιπόν μια φίλη;';
const FOLD = { maxTasks: 4, minPartChars: 30 };

test('parseSplitAnswer: a two-part answer with a short opener folds to one', () => {
  assert.deepEqual(parseSplitAnswer(JSON.stringify({ parts: [OPENER, `${ARGUMENT} ${CLOSER}`] }), FOLD), {
    parts: null,
    reason: 'folded',
  });
});

test('parseSplitAnswer: a short middle part joins the next one', () => {
  assert.deepEqual(parseSplitAnswer(JSON.stringify({ parts: [ARGUMENT, OPENER, CLOSER] }), FOLD), {
    parts: [ARGUMENT, `${OPENER} ${CLOSER}`],
    reason: 'parts',
  });
});

test('parseSplitAnswer: a short last part joins the previous one', () => {
  assert.deepEqual(parseSplitAnswer(JSON.stringify({ parts: [ARGUMENT, CLOSER, OPENER] }), FOLD), {
    parts: [ARGUMENT, `${CLOSER} ${OPENER}`],
    reason: 'parts',
  });
});

test('parseSplitAnswer: minPartChars 0 or a bare maxTasks number folds nothing', () => {
  const answer = JSON.stringify({ parts: [OPENER, ARGUMENT] });
  assert.deepEqual(parseSplitAnswer(answer, { maxTasks: 4, minPartChars: 0 }).parts, [OPENER, ARGUMENT]);
  assert.deepEqual(parseSplitAnswer(answer, 4).parts, [OPENER, ARGUMENT]);
});

test('foldShortParts: a part exactly at the minimum stays', () => {
  const exact = 'é'.repeat(10);
  assert.deepEqual(foldShortParts([exact, 'à'.repeat(12)], 10), [exact, 'à'.repeat(12)]);
  assert.deepEqual(foldShortParts(['é'.repeat(9), 'à'.repeat(12)], 10), [`${'é'.repeat(9)} ${'à'.repeat(12)}`]);
});

test('foldShortParts: links and Discord tokens do not count toward the length', () => {
  const padded = 'κοίτα <@123456789012345678> https://www.example.com/a/very/long/path <:emoji:123456789012345679>';
  assert.deepEqual(foldShortParts([padded, ARGUMENT], 20), [`${padded} ${ARGUMENT}`]);
});

test('foldShortParts: folding repeats until every part meets the minimum', () => {
  assert.deepEqual(foldShortParts(['αα', 'ββ', 'γγ', ARGUMENT], 10), [`αα ββ γγ ${ARGUMENT}`]);
  assert.deepEqual(foldShortParts([ARGUMENT, 'αα', 'ββ'], 10), [`${ARGUMENT} αα ββ`]);
});

test('foldShortParts: does not change its input', () => {
  const parts = ['αα', ARGUMENT];
  foldShortParts(parts, 10);
  assert.deepEqual(parts, ['αα', ARGUMENT]);
});

const worldChannelsOf = (channels: Parameters<typeof worldChannels>[1]) => worldChannels(GUILD, channels);

/** The fixed words of a label before its first placeholder. */
const labelHead = (label: string) => label.split('{')[0];
// The world's wrapper takes the runner factory by the loose options of the tests.
const createTurnRunner = onWorld(createRealTurnRunner as unknown as Parameters<typeof onWorld>[0]);

// ---- the shipped layer --------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROMPTS_DIR = path.join(ROOT, 'prompts');

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
  config: JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: joinLabels(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'))),
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

/** A live view over the shipped layer, the config overridden as given. */
function shippedHot(overrides: Record<string, unknown> = {}) {
  return { config: shippedConfig(overrides), prompts: SHIPPED.prompts };
}

// ---- the checks -----------------------------------------------------------------

/** The text of one message content: a string as is, an array of parts as its text parts. */
function contentText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Every text a request carries, as one string. */
function requestText(messages: Array<{ content: unknown }>) {
  return messages.map((message) => contentText(message.content)).join('\n\n');
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

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const GUILD = '600000000000000001';
const SELF_ID = '900000000000000001';
const SELF_NAME = 'Zoë';
const ANA = '411111111111111111';
const NIKOS = '422222222222222222';
const BJORN = '433333333333333333';
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
  const at = (minutes: number) => NOW - minutes * MINUTE_MS;
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

/** A fake `llm.complete` recording every request and answering `answer(messages, options)`. */
function recordingLlm(answer: (messages: Array<{ content: unknown }>, options: { purpose?: string }) => unknown) {
  const calls: Array<{ messages: Array<{ content: unknown }>; options: { purpose?: string }; text: string }> = [];
  return {
    calls,
    complete: async (messages: Array<{ content: unknown }>, options: { purpose?: string } = {}) => {
      calls.push({ messages, options, text: requestText(messages) });
      const text = await answer(messages, options);
      return { text, usage: { prompt_tokens: 100, completion_tokens: 10 }, estimated: 100, finishReason: 'stop' };
    },
  };
}

// ---- several requests in one message, several calls waiting ------------------------------

const SPLIT_LINE =
  'Zoë, trois choses : qui a planté les tomates, regarde le canal du jardin, et dis-moi si la photo est drôle.';

/** The store a turn reads, empty but for the state: the split tests look at the task labels only. */
function bareStore() {
  return {
    state: { data: {}, markDirty() {} },
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listUserProfiles: () => [],
    listChannels: () => [],
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
  };
}

describe('the splitter over the shipped prompts', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));
  before(() => useSelf('900000000000000001'));
  after(() => useSelf('self-id'));

  // The lead: split, merge and missed answer in strict JSON (owner, 2026-11-06).
  test('createTurnRunner: the splitter fills classify/split.md; each part, its queued calls and a folded message fill labels.task', async () => {
    const hot = shippedHot();
    const line = rawMessage(GENERAL_INFO, {
      ts: NOW - MINUTE_MS,
      author: PEOPLE[ANA],
      content: SPLIT_LINE,
      mentions: [SELF_ID],
    });
    const channel = worldChannelsOf([[GENERAL_INFO, [...generalRaws(), line]]])[GENERAL];
    const llm = recordingLlm((messages, options) =>
      options.purpose === 'split'
        ? JSON.stringify({ parts: ['qui a planté les tomates', 'regarde le canal du jardin'] })
        : '<skip/>'
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
      const part = LABELS.task.part;
      assert.ok(text.includes(part.split('{')[0]), `part ${i + 1}: labels.task.part`);
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
});

// The lead: split, merge and missed answer in strict JSON (owner, 2026-11-06).
test('runTurn: the splitter cuts the parts at its four tasks', async () => {
  // PR 7d: split.maxTasks is the constant 4 (the production value).
  const kept = [...SPLIT_PARTS, 'και κάτι ακόμα πιο μεγάλο'];
  const { llm } = await runSplitTurn({
    llm: splitLlm({ split: JSON.stringify({ parts: [...SPLIT_PARTS, kept[3], 'και ένα τελευταίο ακόμα θέμα'] }) }),
  });
  const talk = llm.calls.talk;
  assert.equal(talk.length, 4);
  assert.ok(taskOf(talk[0]).endsWith(partLabel(1, kept)));
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);
