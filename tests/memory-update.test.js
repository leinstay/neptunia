// Tests for src/memory/update.js: buffering, the memory-update request
// builder and applying the model's JSON reply. tests/fixtures/labels.js is
// an English fixture covering every key of the prompt contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createStore } from '../src/memory/store.js';
import { MEMORY_LIMIT_DEFAULTS, isDue, buildMemoryRequest, applyMemoryUpdate, applyPrivateUpdate, createMemoryUpdater, touchMemory, computeSeenAt, batchAuthorNamesMap, characterText, analyzerTemperature, analyzerMode, feedsCalibration, memorySwitches, resolveMoment, notesStale, reconcileNoteReviews } from '../src/memory/update.js';
import { voiceLimits, mergeIntoQueue, retryLater } from '../src/memory/voice.js';
import { createCalibrator, estimateTokens } from '../src/llm/tokens.js';
import { SectionsTooLargeError } from '../src/llm/budget.js';
import { formatClock, formatDate, formatTranscript } from '../src/format.js';
import { DailyCapError, TokenLimitError } from '../src/llm/openrouter.js';
import { ROLE_DEFAULTS } from '../src/llm/roles.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDay } from '../src/time.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir as makeTempDir } from './fixtures/tmp.js';

function tempDir() {
  return makeTempDir('nep-');
}

function withStore(fn) {
  const dir = tempDir();
  try {
    return fn(createStore({ dataDir: dir }), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withStoreAsync(fn) {
  const dir = tempDir();
  try {
    return await fn(createStore({ dataDir: dir }), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeConfig(overrides = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: { gapMarkerMinutes: 20, maxMessageChars: 800 },
    models: { base: { voice: 'x/y', extractor: 'x/y' } },
    llm: {
      temperature: 1,
      maxOutputTokens: 700,
      maxRequestTokens: 50000,
      safetyMargin: 0.9,
      timeoutMs: 1000,
      retries: 0,
      maxRequestsPerDay: 100,
    },
    memory: {
      batchMessages: 60,
      minBatchMessages: 15,
      maxBatchAgeMinutes: 180,
      maxOutputTokens: 4000,
      fieldChars: 400,
      maxDetails: 15,
      maxInjokes: 15,
      maxSelfFacts: 20,
    },
    ...overrides,
  };
}

function slimMessage(overrides) {
  return {
    id: 'm1',
    channelId: 'c1',
    channelName: 'general',
    authorId: '1',
    authorName: 'nick',
    self: false,
    bot: false,
    content: 'hello',
    ts: Date.now(),
    replyToId: null,
    attachments: [],
    stickers: [],
    ...overrides,
  };
}

// ---- isDue ----------------------------------------------------------------

test('isDue: false when the buffer is short and fresh', () => {
  const cfg = { batchMessages: 10, minBatchMessages: 3, maxBatchAgeMinutes: 60 };
  const buffer = [{ ts: 1000 }, { ts: 1000 }];
  assert.equal(isDue(buffer, 2000, cfg), false);
});

test('isDue: true once the buffer reaches batchMessages, regardless of age', () => {
  const cfg = { batchMessages: 3, minBatchMessages: 10, maxBatchAgeMinutes: 999 };
  const buffer = [{ ts: 1000 }, { ts: 1000 }, { ts: 1000 }];
  assert.equal(isDue(buffer, 1001, cfg), true);
});

test('isDue: true when minBatchMessages is met and the oldest message aged out', () => {
  const cfg = { batchMessages: 100, minBatchMessages: 2, maxBatchAgeMinutes: 10 };
  const buffer = [{ ts: 0 }, { ts: 5000 }];
  assert.equal(isDue(buffer, 10 * 60_000 + 1, cfg), true);
});

test('isDue: false when minBatchMessages is met but the oldest message is still fresh', () => {
  const cfg = { batchMessages: 100, minBatchMessages: 2, maxBatchAgeMinutes: 10 };
  const buffer = [{ ts: 0 }, { ts: 5000 }];
  assert.equal(isDue(buffer, 5 * 60_000, cfg), false);
});

test('isDue: a pile-up of direct messages triggers early, before the regular batch fills', () => {
  const cfg = { batchMessages: 100, minBatchMessages: 100, maxBatchAgeMinutes: 999 };
  const relationshipsCfg = { directTriggerCount: 3 };
  const buffer = [{ ts: 0, direct: true }, { ts: 0, direct: false }, { ts: 0, direct: true }, { ts: 0, direct: true }];
  assert.equal(isDue(buffer, 1, cfg, relationshipsCfg), true);
});

test('isDue: direct messages below directTriggerCount do not trigger', () => {
  const cfg = { batchMessages: 100, minBatchMessages: 100, maxBatchAgeMinutes: 999 };
  const relationshipsCfg = { directTriggerCount: 3 };
  const buffer = [{ ts: 0, direct: true }, { ts: 0, direct: true }];
  assert.equal(isDue(buffer, 1, cfg, relationshipsCfg), false);
});

test('isDue: relationshipsCfg absent or directTriggerCount 0 never triggers on direct messages alone', () => {
  const cfg = { batchMessages: 100, minBatchMessages: 100, maxBatchAgeMinutes: 999 };
  const buffer = [{ ts: 0, direct: true }, { ts: 0, direct: true }, { ts: 0, direct: true }];
  assert.equal(isDue(buffer, 1, cfg, undefined), false);
  assert.equal(isDue(buffer, 1, cfg, { directTriggerCount: 0 }), false);
});

test('isDue: maxAgeMinutes makes a buffer below every count due once its oldest line is that old', () => {
  const cfg = { batchMessages: 60, minBatchMessages: 15, maxBatchAgeMinutes: 180 };
  const buffer = [{ ts: 0 }, { ts: 90 * MINUTE_MS }];
  assert.equal(isDue(buffer, 360 * MINUTE_MS - 1, cfg, undefined, { maxAgeMinutes: 360 }), false, 'not before');
  assert.equal(isDue(buffer, 360 * MINUTE_MS, cfg, undefined, { maxAgeMinutes: 360 }), true, 'measured from the oldest line');
});

test('isDue: no maxAgeMinutes (the guild path), 0 or a value that is no positive number adds no age path, and an empty buffer is never due', () => {
  const cfg = { batchMessages: 60, minBatchMessages: 15, maxBatchAgeMinutes: 180 };
  const late = 10_000 * MINUTE_MS;
  assert.equal(isDue([{ ts: 0 }], late, cfg), false);
  for (const maxAgeMinutes of [0, -5, null, 'έξι ώρες']) {
    assert.equal(isDue([{ ts: 0 }], late, cfg, undefined, { maxAgeMinutes }), false, JSON.stringify(maxAgeMinutes));
  }
  assert.equal(isDue([], late, cfg, undefined, { maxAgeMinutes: 1 }), false);
});

// ---- buildMemoryRequest -----------------------------------------------------

test('buildMemoryRequest: carries the memory prompt and both JSON blocks', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages, consumed } = buildMemoryRequest({
    prompts: { memory: 'memory system prompt', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['nick'], character: 'cheerful', interests: [], style: '', details: [], relationship: '' } },
    guildMemory: { patterns: 'chats all day', starters: '', injokes: [], self: [] },
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].role, 'system');
  assert.equal(llmMessages[0].content, 'memory system prompt');
  assert.equal(llmMessages[1].role, 'user');
  const user = llmMessages[1].content;
  assert.match(user, /<existing_profiles>[\s\S]*<\/existing_profiles>/);
  assert.match(user, /<existing_guild>[\s\S]*<\/existing_guild>/);
  assert.match(user, /<new_messages>[\s\S]*<\/new_messages>/);
  assert.ok(user.includes('cheerful'));
  assert.ok(user.includes('chats all day'));
  // Only the whitelisted profile fields travel, never messageCount/id/firstSeen etc.
  assert.ok(!user.includes('messageCount'));
  assert.equal(consumed, 1);
});

test('buildMemoryRequest: fills {{name}} in the memory system prompt', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'You are {{name}}, summarize the chat.', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].content, 'You are Nept, summarize the chat.');
});

// ---- buildMemoryRequest: limit placeholders --------------------------------

test('buildMemoryRequest: fills every limit placeholder from config.memory / config.relationships', () => {
  const config = makeConfig({
    memory: {
      ...makeConfig().memory,
      fieldChars: 1000,
      maxDetails: 7,
      maxInjokes: 8,
      maxSelfFacts: 9,
      maxNewEpisodes: 2,
      maxEpisodes: 30,
      maxInterests: 20,
      interestTopicChars: 25,
      interestNoteChars: 90,
      maxLearned: 7,
      learnedChars: 70,
    },
    relationships: { maxDeltaPerUpdate: 25 },
    lore: { textChars: 450 },
  });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];
  const template =
    '{{fieldChars}} {{guildFieldChars}} {{maxDetails}} {{maxInjokes}} {{maxSelfFacts}} {{maxNewEpisodes}} {{maxEpisodes}} {{maxDeltaPerUpdate}} {{maxInterests}} {{interestTopicChars}} {{interestNoteChars}} {{loreTextChars}} {{maxLearned}} {{learnedChars}}';

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: template, labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].content, '1000 2000 7 8 9 2 30 25 20 25 90 450 7 70');
});

test('buildMemoryRequest: absent config keys fall back to the shared limit table, which tests/text-limits.test.js ties to config.json', () => {
  const config = makeConfig({ memory: {} }); // no relationships, no lore block either
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];
  const names = ['fieldChars', 'maxDetails', 'maxInjokes', 'maxSelfFacts', 'maxNewEpisodes', 'maxEpisodes', 'maxDeltaPerUpdate', 'maxInterests', 'interestTopicChars', 'interestNoteChars', 'loreTextChars', 'maxLearned', 'learnedChars'];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: names.map((name) => `{{${name}}}`).join(' '), labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].content, names.map((name) => String(MEMORY_LIMIT_DEFAULTS[name])).join(' '));
});

test('buildMemoryRequest: throws a clear error when prompts.labels is missing', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  assert.throws(
    () =>
      buildMemoryRequest({
        prompts: { memory: 'sys' },
        config,
        calibrator,
        profiles: {},
        guildMemory: {},
        messages: [slimMessage()],
        selfName: 'Nept',
      }),
    /labels/,
  );
});

test('buildMemoryRequest: memory transcript lines use "[hh:mm] nick (id:1): text"', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', authorId: '1', authorName: 'nick', content: 'text', ts: Date.UTC(2026, 0, 1, 14, 32, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.match(llmMessages[1].content, /\[14:32\] nick \(id:1\): text/);
});

/** Five one-minute-apart lines against a cap that holds the required blocks plus the `lines` oldest ones. */
function fiveLineRequest(lines) {
  const calibrator = createCalibrator();
  const cost = (text) => calibrator.apply(estimateTokens(text)) + 2;
  const system = 'S';
  const fixedCost =
    cost(system) +
    cost(`<existing_profiles>\n${JSON.stringify({})}\n</existing_profiles>`) +
    cost(`<existing_guild>\n${JSON.stringify({ patterns: '', starters: '', injokes: [], self: [], learned: [] })}\n</existing_guild>`) +
    cost(`<existing_channels>\n${JSON.stringify({})}\n</existing_channels>`);
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  const messages = [0, 1, 2, 3, 4].map((i) => slimMessage({ id: `m${i}`, content: `message number ${i}`, ts: base + i * 60_000 }));
  const lineTexts = formatTranscript(messages, { timezone: 'UTC', gapMinutes: 20, maxChars: 800, selfName: 'Nept', mode: 'memory', labels }).map(
    (item) => item.text,
  );
  const linesCost = lineTexts.slice(0, lines).reduce((sum, text) => sum + cost(text), 0);
  const config = makeConfig({ llm: { ...makeConfig().llm, maxRequestTokens: fixedCost + linesCost, safetyMargin: 1 } });
  return buildMemoryRequest({ prompts: { memory: system, labels }, config, calibrator, profiles: {}, guildMemory: {}, messages, selfName: 'Nept' });
}

test('buildMemoryRequest: a transcript over the cap consumes only the oldest lines that fit and reports the rest deferred', () => {
  const { messages: llmMessages, consumed, shown, deferred } = fiveLineRequest(2);
  assert.equal(consumed, 2, 'consumed === shown: nothing is consumed unseen');
  assert.equal(shown, 2);
  assert.equal(deferred, 3);
  assert.equal(shown + deferred, 5, 'the batch');
  const user = llmMessages[1].content;
  assert.ok(user.includes('message number 0') && user.includes('message number 1'), 'the two oldest lines are the ones shown');
  assert.ok(!user.includes('message number 2'));
});

test('buildMemoryRequest: a transcript that fits reports every line shown and none deferred', () => {
  const messages = [0, 1, 2].map((i) => slimMessage({ id: `m${i}`, content: `hi ${i}`, ts: Date.UTC(2026, 0, 1, 12, i) }));
  const { consumed, shown, deferred } = buildMemoryRequest({
    prompts: { memory: 'memory system prompt', labels },
    config: makeConfig(),
    calibrator: createCalibrator(),
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });
  assert.equal(consumed, 3);
  assert.equal(shown, 3);
  assert.equal(deferred, 0);
});

test('buildMemoryRequest: no transcript line fits beside the required sections -> SectionsTooLargeError, never a batch consumed unseen', () => {
  // A cap one token short of the required blocks plus the oldest line.
  const calibrator = createCalibrator();
  const cost = (text) => calibrator.apply(estimateTokens(text)) + 2;
  const messages = [0, 1].map((i) => slimMessage({ id: `m${i}`, content: `γραμμή ${i}`, ts: Date.UTC(2026, 0, 1, 12, i) }));
  const lineTexts = formatTranscript(messages, { timezone: 'UTC', gapMinutes: 20, maxChars: 800, selfName: 'Nept', mode: 'memory', labels }).map((item) => item.text);
  const fixedCost =
    cost('S') +
    cost(`<existing_profiles>\n${JSON.stringify({})}\n</existing_profiles>`) +
    cost(`<existing_guild>\n${JSON.stringify({ patterns: '', starters: '', injokes: [], self: [], learned: [] })}\n</existing_guild>`) +
    cost(`<existing_channels>\n${JSON.stringify({})}\n</existing_channels>`);
  const request = (maxRequestTokens) =>
    buildMemoryRequest({
      prompts: { memory: 'S', labels },
      config: makeConfig({ llm: { ...makeConfig().llm, maxRequestTokens, safetyMargin: 1 } }),
      calibrator,
      profiles: {},
      guildMemory: {},
      messages,
      selfName: 'Nept',
    });

  assert.throws(() => request(fixedCost + cost(lineTexts[0]) - 1), SectionsTooLargeError);
  assert.equal(request(fixedCost + cost(lineTexts[0])).shown, 1, 'one token more: the oldest line goes');
});

test('buildMemoryRequest: llm.safetyMargin null, missing or outside (0, 1] counts as 0.9, so the transcript is still trimmed; a missing maxRequestTokens counts as 50000', () => {
  const messages = Array.from({ length: 40 }, (_, i) => slimMessage({ id: `m${i}`, content: `γραμμή ${i} ${'word '.repeat(60)}`, ts: Date.UTC(2026, 0, 1, 12, i) }));
  const request = (llm) =>
    buildMemoryRequest({ prompts: { memory: 'S', labels }, config: makeConfig({ llm }), calibrator: createCalibrator(), profiles: {}, guildMemory: {}, messages, selfName: 'Nept' });

  const reference = request({ maxRequestTokens: 2000, safetyMargin: 0.9 });
  assert.ok(reference.shown > 0 && reference.deferred > 0, 'this batch is cut at the cap');
  for (const safetyMargin of [null, undefined, 0, 1.5, '0.9']) {
    const cut = request({ maxRequestTokens: 2000, safetyMargin });
    assert.equal(cut.shown, reference.shown, `safetyMargin ${JSON.stringify(safetyMargin)}`);
    assert.equal(cut.messages[1].content, reference.messages[1].content);
  }

  // Over 45000 tokens of 800-character lines: a missing cap is 50000, not "keep everything".
  const long = Array.from({ length: 300 }, (_, i) => slimMessage({ id: `l${i}`, content: `${i} ${'λέξη '.repeat(200)}`, ts: Date.UTC(2026, 0, 2, 0, i) }));
  const longRequest = (llm) =>
    buildMemoryRequest({ prompts: { memory: 'S', labels }, config: makeConfig({ llm }), calibrator: createCalibrator(), profiles: {}, guildMemory: {}, messages: long, selfName: 'Nept' });
  const capped = longRequest({ maxRequestTokens: 50000, safetyMargin: 0.9 });
  assert.ok(capped.deferred > 0, 'the explicit cap cuts it');
  assert.equal(longRequest({ safetyMargin: 0.9 }).shown, capped.shown);
});

// ---- relationships: <character> block + affinity in existing profiles ------

test('buildMemoryRequest: relationships on prepends a <character> block with {{name}} filled', () => {
  const config = makeConfig({ features: { relationships: true } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', 'character-card': 'Card of {{name}}, a cheerful person.', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  assert.match(user, /<character>[\s\S]*Card of Nept, a cheerful person\.[\s\S]*<\/character>/);
});

test('buildMemoryRequest: relationships off never renders a <character> block', () => {
  const config = makeConfig({ features: { relationships: false } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', 'character-card': 'Card of {{name}}.', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.ok(!llmMessages[1].content.includes('<character>'));
  assert.ok(!llmMessages[1].content.includes('Card of Nept'));
});

// ---- <character> = card + the owner's live rules, same as the chat prompt ----

test('characterText: joins the card and the rules with a blank line, both {{name}} filled', () => {
  const text = characterText({ 'character-card': 'Card of {{name}}.', rules: 'Never mention {{name}} twice.' }, 'Nept');
  assert.equal(text, 'Card of Nept.\n\nNever mention Nept twice.');
});

test('characterText: no rules -> the card alone', () => {
  const text = characterText({ 'character-card': 'Card of {{name}}.' }, 'Nept');
  assert.equal(text, 'Card of Nept.');
});

test('buildMemoryRequest: relationships on appends prompts.rules after the card in the <character> block', () => {
  const config = makeConfig({ features: { relationships: true } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', 'character-card': 'Card of {{name}}.', rules: 'Never say {{name}} twice.', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  assert.match(user, /<character>\nCard of Nept\.\n\nNever say Nept twice\.\n<\/character>/);
});

test('buildMemoryRequest: relationships on adds affinity: { score, band, reason } to each existing profile', () => {
  const config = makeConfig({ features: { relationships: true } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['nick'], character: '', interests: [], style: '', details: [], relationship: '', affinity: { score: 42, reason: 'helped once', history: [] } } },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].affinity, { score: 42, band: 'fond', reason: 'helped once' });
});

test('buildMemoryRequest: a damped (fractional) stored score is rounded to an integer for the analyzer', () => {
  const config = makeConfig({ features: { relationships: true } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['nick'], character: '', interests: [], style: '', details: [], relationship: '', affinity: { score: 60.4, reason: 'helped once', history: [] } } },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].affinity, { score: 60, band: 'devoted', reason: 'helped once' });
});

test('buildMemoryRequest: relationships off never adds affinity to existing profiles', () => {
  const config = makeConfig({ features: { relationships: false } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['nick'], character: '', interests: [], style: '', details: [], relationship: '', affinity: { score: 42, reason: 'helped once', history: [] } } },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.equal(profiles['1'].affinity, undefined);
});

// ---- buildMemoryRequest: <existing_channels> + channel grouping -----------

test('buildMemoryRequest: always renders an <existing_channels> block, keyed by channel id', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    channels: { c1: { name: 'general', category: 'Text', topic: 'chat', purpose: 'chatter', topics: 'games', tone: 'casual' } },
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const channels = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(user)[1]);
  assert.deepEqual(channels, {
    c1: { name: 'general', category: 'Text', topic: 'chat', purpose: 'chatter', topics: 'games', tone: 'casual' },
  });
});

// ---- buildMemoryRequest: <existing_channels> "main" flag -------------------

test('buildMemoryRequest: a channel listed in memory.mainChannelIds carries "main": true, others omit the key', () => {
  const config = makeConfig({ memory: { ...makeConfig().memory, mainChannelIds: ['c1'] } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    channels: {
      c1: { name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '' },
      c2: { name: 'diary', category: null, topic: null, purpose: '', topics: '', tone: '' },
    },
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const channels = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(user)[1]);
  assert.equal(channels.c1.main, true);
  assert.equal('main' in channels.c2, false);
});

test('buildMemoryRequest: memory.mainChannelIds compares ids as strings, numbers-in-strings included', () => {
  const config = makeConfig({ memory: { ...makeConfig().memory, mainChannelIds: [123] } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', channelId: '123', channelName: 'general', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    channels: { 123: { name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '' } },
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const channels = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(user)[1]);
  assert.equal(channels['123'].main, true);
});

test('buildMemoryRequest: non-string/garbage entries in memory.mainChannelIds are coerced, never throw', () => {
  const config = makeConfig({ memory: { ...makeConfig().memory, mainChannelIds: [null, {}, ['x'], 'c1'] } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    channels: { c1: { name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '' } },
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const channels = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(user)[1]);
  assert.equal(channels.c1.main, true);
});

// ---- server and channel notes: staleness markers ----------------------------

const NOTES_NOW = Date.UTC(2026, 0, 20, 12);
const notesDaysAgo = (days) => new Date(NOTES_NOW - days * DAY_MS).toISOString();
/** The `YYYY-MM-DD` (UTC) of `days` days before NOTES_NOW: a key of a channel's `days` tally. */
const dayOf = (days) => utcDay(NOTES_NOW - days * DAY_MS);

test('notesStale: stale from the later of the two stamps once notesStaleDays passed, days counted from the text; never stamped is stale; 0 is off', () => {
  assert.deepEqual(notesStale({ updatedAt: notesDaysAgo(9) }, NOTES_NOW, 7), { days: 9 });
  assert.deepEqual(notesStale({ updatedAt: notesDaysAgo(7) }, NOTES_NOW, 7), { days: 7 }, 'exactly notesStaleDays is stale');
  assert.equal(notesStale({ updatedAt: notesDaysAgo(6) }, NOTES_NOW, 7), null);
  assert.equal(notesStale({ updatedAt: notesDaysAgo(30), checkedAt: notesDaysAgo(2) }, NOTES_NOW, 7), null, 'a recent check counts');
  assert.deepEqual(notesStale({ updatedAt: notesDaysAgo(30), checkedAt: notesDaysAgo(8) }, NOTES_NOW, 7), { days: 30 }, 'days from the text, not the check');
  assert.deepEqual(notesStale({ updatedAt: NOTES_NOW - 10 * DAY_MS }, NOTES_NOW, 7), { days: 10 }, 'an epoch-ms stamp reads too');
  assert.deepEqual(notesStale({}, NOTES_NOW, 7), { days: null }, 'never stamped');
  assert.deepEqual(notesStale({ updatedAt: 'χθες', checkedAt: null }, NOTES_NOW, 7), { days: null }, 'a stamp that is no time counts as missing');
  assert.equal(notesStale({ checkedAt: notesDaysAgo(1) }, NOTES_NOW, 7), null, 'checked recently, never written');
  for (const staleDays of [0, -1, '7', null]) {
    assert.equal(notesStale({}, NOTES_NOW, staleDays), null, `staleDays ${JSON.stringify(staleDays)}`);
  }
});

/** `count` one-second-apart lines in `channelId`, the last an hour before NOTES_NOW. */
function notesLines(channelId, count) {
  return Array.from({ length: count }, (_, i) =>
    slimMessage({ id: `${channelId}-${i}`, channelId, channelName: `κανάλι-${channelId}`, content: `γραμμή ${i}`, ts: NOTES_NOW - HOUR_MS - (count - i) * 1000 }),
  );
}

/** A stored channel entry with notes, `extra` (the stamps) merged in. */
function notesChannel(name, extra = {}) {
  return { name, category: null, topic: null, purpose: 'κουβέντα', topics: 'γάτες', tone: 'ήρεμο', ...extra };
}

/** One guild request over `messages` at NOTES_NOW; `memory` merged into makeConfig().memory; `guildChannels` every stored channel. */
function notesRequest({ messages, channels = {}, guildChannels, guildMemory = {}, memory = {}, stage, prompts = { memory: 'sys', labels } }) {
  return buildMemoryRequest({
    prompts,
    config: makeConfig({ memory: { ...makeConfig().memory, ...memory } }),
    calibrator: createCalibrator(),
    profiles: {},
    guildMemory,
    channels,
    guildChannels,
    messages,
    selfName: 'Nept',
    now: NOTES_NOW,
    stage,
  });
}

const channelsOf = (request) => JSON.parse(blockBody(request.messages[1].content, 'existing_channels'));
const guildOf = (request) => JSON.parse(blockBody(request.messages[1].content, 'existing_guild'));

test('buildMemoryRequest: a channel is flagged when the batch has memory.notesBatchLines of it, memory.notesMinMessages accumulated since the last check, stale notes and no flag within memory.notesRetryHours, main or not', () => {
  const lots = { [dayOf(0)]: 50 };
  const channels = {
    // stale, 40 messages over the last 3 days, 8 lines in the batch
    c1: notesChannel('γενικό', { updatedAt: notesDaysAgo(10), days: { [dayOf(0)]: 20, [dayOf(1)]: 10, [dayOf(2)]: 10 } }),
    c2: notesChannel('ήσυχο', { updatedAt: notesDaysAgo(10), days: { [dayOf(0)]: 12 } }),
    c3: notesChannel('σημαδεμένο', { updatedAt: notesDaysAgo(10), notesFlaggedAt: new Date(NOTES_NOW - 2 * HOUR_MS).toISOString(), days: lots }),
    c4: notesChannel('λίγες', { updatedAt: notesDaysAgo(10), days: lots }),
    c5: notesChannel('άγραφο', { updatedAt: null, days: lots }),
    c6: notesChannel('ελεγμένο', { updatedAt: notesDaysAgo(30), notesCheckedAt: notesDaysAgo(1), days: lots }),
    c7: notesChannel('περίμενε', { updatedAt: notesDaysAgo(10), notesFlaggedAt: new Date(NOTES_NOW - 25 * HOUR_MS).toISOString(), days: lots }),
    // busy before the last check, quiet since: only what came after counts
    c8: notesChannel('παλιό', { updatedAt: notesDaysAgo(30), notesCheckedAt: notesDaysAgo(8), days: { [dayOf(9)]: 100, [dayOf(0)]: 29 } }),
    c9: notesChannel('φρέσκο', { updatedAt: notesDaysAgo(2), days: lots }),
  };
  const messages = ['c1', 'c2', 'c3', 'c5', 'c6', 'c7', 'c8', 'c9'].flatMap((id) => notesLines(id, 8)).concat(notesLines('c4', 7));
  const memory = { mainChannelIds: ['c1'], notesBatchLines: 8, notesMinMessages: 30, notesStaleDays: 7, notesRetryHours: 24 };

  for (const [stage, prompts] of [
    ['single', { memory: 'sys', labels }],
    ['decide', { 'memory-decide': 'sys A', labels }],
  ]) {
    const request = notesRequest({ messages, channels, memory, stage, prompts });
    const shown = channelsOf(request);
    assert.deepEqual(shown.c1.stale, { days: 10 }, `${stage}: a main channel`);
    assert.equal('stale' in shown.c2, false, `${stage}: 12 accumulated is too quiet`);
    assert.equal('stale' in shown.c3, false, `${stage}: flagged 2 hours ago`);
    assert.equal('stale' in shown.c4, false, `${stage}: 7 batch lines`);
    assert.deepEqual(shown.c5.stale, { days: null }, `${stage}: never written`);
    assert.equal('stale' in shown.c6, false, `${stage}: checked yesterday`);
    assert.deepEqual(shown.c7.stale, { days: 10 }, `${stage}: flagged 25 hours ago, the wait is over`);
    assert.equal('stale' in shown.c8, false, `${stage}: 29 since the check`);
    assert.equal('stale' in shown.c9, false, `${stage}: written 2 days ago`);
    assert.equal(shown.c1.main, true);
    assert.equal(shown.c1.purpose, 'κουβέντα', 'the marker adds a field, the notes are shown as stored');
    assert.equal('days' in shown.c1, false, 'the tally is never shown');
    assert.deepEqual(request.staleNotes.channels, ['c1', 'c5', 'c7']);
  }
});

test('buildMemoryRequest: existing_guild carries stale once the batch has memory.notesBatchLines lines, every stored channel accumulated memory.notesGuildMinMessages since the last check, the notes are stale and no flag went out within memory.notesRetryHours', () => {
  const messages = [...notesLines('c1', 4), ...notesLines('c2', 4)];
  const old = { patterns: 'μιμίδια', notesUpdatedAt: notesDaysAgo(9) };
  const busy = [notesChannel('ένα', { days: { [dayOf(0)]: 60 } }), notesChannel('δύο', { days: { [dayOf(1)]: 40, [dayOf(12)]: 500 } })];
  const memory = { notesBatchLines: 8, notesGuildMinMessages: 100, notesStaleDays: 7, notesRetryHours: 24 };
  const request = (overrides) => notesRequest({ messages, guildMemory: old, guildChannels: busy, memory, ...overrides });

  const flagged = request({});
  assert.deepEqual(guildOf(flagged).stale, { days: 9 }, 'lines of every channel count, the whole server\'s activity counts');
  assert.equal(flagged.staleNotes.guild, true);

  const quiet = request({ messages: messages.slice(1) });
  assert.equal('stale' in guildOf(quiet), false, '7 lines');
  assert.equal(quiet.staleNotes.guild, false);

  const thin = request({ guildChannels: [busy[0], notesChannel('δύο', { days: { [dayOf(1)]: 39 } })] });
  assert.equal(thin.staleNotes.guild, false, '99 accumulated');

  const sinceCheck = request({ guildMemory: { ...old, notesCheckedAt: notesDaysAgo(8) } });
  assert.equal(sinceCheck.staleNotes.guild, true, 'checked 8 days ago, 100 since');
  const before = request({ guildMemory: { ...old, notesCheckedAt: notesDaysAgo(8) }, guildChannels: [busy[0], notesChannel('δύο', { days: { [dayOf(9)]: 40 } })] });
  assert.equal(before.staleNotes.guild, false, 'activity before the check does not count');

  const checked = request({ guildMemory: { ...old, notesCheckedAt: notesDaysAgo(1) } });
  assert.equal('stale' in guildOf(checked), false, 'answered within notesStaleDays');

  const waiting = request({ guildMemory: { ...old, notesFlaggedAt: new Date(NOTES_NOW - 2 * HOUR_MS).toISOString() } });
  assert.equal(waiting.staleNotes.guild, false, 'flagged 2 hours ago');
  const waited = request({ guildMemory: { ...old, notesFlaggedAt: new Date(NOTES_NOW - 24 * HOUR_MS).toISOString() } });
  assert.equal(waited.staleNotes.guild, true, 'flagged notesRetryHours ago');

  const selfOnly = request({ guildMemory: { patterns: 'μιμίδια', updatedAt: notesDaysAgo(0) } });
  assert.deepEqual(guildOf(selfOnly).stale, { days: null }, 'updatedAt (a self fact, a lesson) is no notes stamp');
});

test('buildMemoryRequest: memory.notesStaleDays 0 sends no marker, and the notes thresholds are read at each request', () => {
  const messages = notesLines('c1', 5);
  const channels = { c1: notesChannel('γενικό', { updatedAt: notesDaysAgo(30), days: { [dayOf(0)]: 5 } }) };
  const low = { notesBatchLines: 5, notesMinMessages: 5, notesGuildMinMessages: 5 };

  const off = notesRequest({ messages, channels, memory: { ...low, notesStaleDays: 0 } });
  assert.equal('stale' in channelsOf(off).c1, false);
  assert.equal('stale' in guildOf(off), false);
  assert.deepEqual(off.staleNotes, { channels: [], guild: false });

  const on = notesRequest({ messages, channels, memory: { ...low, notesStaleDays: 7 } });
  assert.deepEqual(channelsOf(on).c1.stale, { days: 30 });
  assert.deepEqual(on.staleNotes, { channels: ['c1'], guild: true }, 'without guildChannels the batch\'s channels are the server\'s activity');

  const fallbacks = notesRequest({ messages, channels, memory: { notesStaleDays: 7 } });
  assert.deepEqual(fallbacks.staleNotes, { channels: [], guild: false }, '8 lines / 30 / 100 by default');
});

test('buildMemoryRequest: a private batch carries no notes marker', () => {
  const messages = Array.from({ length: 25 }, (_, i) =>
    slimMessage({ id: `d${i}`, channelId: 'dm1', channelName: 'Zoé', authorId: 'u1', authorName: 'Zoé', ts: NOTES_NOW - HOUR_MS + i * 1000 }),
  );
  const request = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config: makeConfig(),
    calibrator: createCalibrator(),
    profiles: { u1: {} },
    guildMemory: { patterns: 'μιμίδια' },
    messages,
    selfName: 'Nept',
    now: NOTES_NOW,
    privateChat: { publicProfile: { id: 'u1', names: ['Zoé'], interests: [], details: [], aliases: [] }, now: NOTES_NOW },
  });
  assert.equal('stale' in guildOf(request), false);
  assert.deepEqual(request.staleNotes, { channels: [], guild: false });
});

test('run: a successful guild batch records every flagged target with store.markNotesFlagged and stamps store.markNotesChecked only for a valid review; a failed one marks nothing', async () => {
  const reviews = '{"note_reviews":[{"target":"c1","status":"confirmed"},{"target":"guild","status":"insufficient_evidence"}]}';
  for (const answer of ['{}', reviews, 'καμία απάντηση']) {
    await withStoreAsync(async (store) => {
      const guildId = 'g1';
      for (const message of [...notesLines('c1', 20), ...notesLines('c2', 3)]) {
        touchMemory(store, guildId, message);
        store.pushBuffer(guildId, message, 100);
      }
      const flagged = [];
      const marked = [];
      store.markNotesFlagged = (...args) => flagged.push(args);
      store.markNotesChecked = (...args) => marked.push(args);
      const memory = { ...makeConfig().memory, batchMessages: 23, minBatchMessages: 1, notesBatchLines: 8, notesMinMessages: 20, notesGuildMinMessages: 20 };
      const hot = { config: makeConfig({ memory }), prompts: { memory: 'sys', labels } };
      const llm = { complete: async () => ({ text: answer }) };
      const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => NOTES_NOW });

      const { logs } = await withCapturedLogs(() => updater.run(guildId));
      const applied = logs.find((entry) => entry.msg === 'memory: update applied');

      if (answer === 'καμία απάντηση') {
        assert.deepEqual([flagged, marked], [[], []], 'a failed batch is retried, flagged again');
        return;
      }
      assert.deepEqual(flagged, [[guildId, { channels: ['c1'], guild: true }, NOTES_NOW]], 'the quiet channel is not flagged');
      assert.equal(applied.notesFlagged, 2);
      for (const key of ['noteReviews', 'changedChannels', 'guildChanged']) assert.equal(key in applied, false, `no ${key} in the log line`);
      if (answer === '{}') {
        assert.deepEqual(marked, [], 'no review, no stamp');
        assert.deepEqual([applied.notesMissing, applied.notesConfirmed, applied.notesInsufficient], [2, 0, 0]);
      } else {
        assert.deepEqual(marked, [[guildId, { channels: ['c1'], guild: false }, NOTES_NOW]]);
        assert.deepEqual([applied.notesConfirmed, applied.notesInsufficient, applied.notesMissing], [1, 1, 0]);
        assert.deepEqual([applied.notesUpdated, applied.notesIdentical, applied.notesUnflagged], [0, 0, 0]);
      }
    });
  }
});

test('run: with nothing flagged the log line carries notesFlagged 0 and no review counts', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    for (const message of notesLines('c1', 3)) {
      touchMemory(store, guildId, message);
      store.pushBuffer(guildId, message, 100);
    }
    const hot = { config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 3, minBatchMessages: 1 } }), prompts: { memory: 'sys', labels } };
    const llm = { complete: async () => ({ text: '{"note_reviews":[{"target":"c1","status":"confirmed"}]}' }) };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => NOTES_NOW });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));
    const applied = logs.find((entry) => entry.msg === 'memory: update applied');
    assert.equal(applied.notesFlagged, 0);
    assert.equal('notesUnflagged' in applied, false);
    assert.equal(store.getChannel(guildId, 'c1').notesCheckedAt, null, 'a review of an unflagged channel stamps nothing');
  });
});

test('run: a two-stage batch reconciles note_reviews the same way', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    for (const message of notesLines('c1', 20)) {
      touchMemory(store, guildId, message);
      store.pushBuffer(guildId, message, 100);
    }
    const marked = [];
    store.markNotesChecked = (...args) => marked.push(args);
    const hot = twoStageHot({ batchMessages: 20, minBatchMessages: 1, notesBatchLines: 8, notesMinMessages: 20, notesGuildMinMessages: 20 });
    const llm = recordingLlm({ note_reviews: [{ target: 'c1', status: 'confirmed' }, { target: 'guild', status: 'updated' }] });
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => NOTES_NOW });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));
    const applied = logs.find((entry) => entry.msg === 'memory: update applied');
    assert.equal(applied.stage, 'two');
    assert.deepEqual(marked, [[guildId, { channels: ['c1'], guild: false }, NOTES_NOW]]);
    assert.deepEqual([applied.notesFlagged, applied.notesConfirmed, applied.notesIdentical], [2, 1, 1], 'the guild said updated and changed nothing');
  });
});

test('run: a flagged target answered updated with identical text is not stamped, and is flagged again once memory.notesRetryHours pass, not memory.notesStaleDays', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    let nowValue = NOTES_NOW;
    const batch = () => {
      for (const message of notesLines('c1', 20)) {
        touchMemory(store, guildId, message);
        store.pushBuffer(guildId, message, 100);
      }
    };
    batch();
    store.updateChannel(guildId, 'c1', { purpose: 'κουβέντα' });
    store.getChannel(guildId, 'c1').updatedAt = notesDaysAgo(30);
    // Notes written before any stamp existed (a stamp of the wall clock would be "fresh" here).
    store.getGuild(guildId).patterns = 'μιμίδια';
    // The same notes back, claimed as updated: nothing changes, so nothing earns the check stamp.
    const llm = recordingLlm({
      channels: { c1: { purpose: 'κουβέντα' } },
      guild: { patterns: 'μιμίδια' },
      note_reviews: [{ target: 'c1', status: 'updated' }, { target: 'guild', status: 'updated' }],
    });
    const memory = { ...makeConfig().memory, batchMessages: 20, minBatchMessages: 1, notesBatchLines: 8, notesMinMessages: 20, notesGuildMinMessages: 20, notesStaleDays: 7, notesRetryHours: 24 };
    const hot = { config: makeConfig({ memory }), prompts: { memory: 'sys', labels } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowValue });
    const markers = (call) => {
      const content = llm.calls[call].messages[1].content;
      return [JSON.parse(blockBody(content, 'existing_channels')).c1.stale ?? null, JSON.parse(blockBody(content, 'existing_guild')).stale ?? null];
    };

    const { logs } = await withCapturedLogs(() => updater.run(guildId));
    assert.deepEqual(markers(0), [{ days: 30 }, { days: null }], 'both flagged');
    const applied = logs.find((entry) => entry.msg === 'memory: update applied');
    assert.deepEqual([applied.notesFlagged, applied.channels, applied.guild, applied.notesIdentical, applied.notesUpdated], [2, 0, false, 2, 0]);
    assert.equal(store.getChannel(guildId, 'c1').notesCheckedAt, null, 'not stamped');
    assert.equal(store.getGuild(guildId).notesCheckedAt, null, 'not stamped');
    assert.equal(store.getChannel(guildId, 'c1').notesFlaggedAt, new Date(NOTES_NOW).toISOString());

    nowValue = NOTES_NOW + 23 * HOUR_MS;
    batch();
    await withCapturedLogs(() => updater.run(guildId));
    assert.deepEqual(markers(1), [null, null], 'flagged 23 hours ago: no marker, no loop');

    nowValue = NOTES_NOW + 24 * HOUR_MS;
    batch();
    await withCapturedLogs(() => updater.run(guildId));
    assert.deepEqual(markers(2), [{ days: 31 }, { days: null }], 'notesRetryHours after the flag: flagged again');
  });
});

test('applyMemoryUpdate: note_reviews are kept per target with valid statuses only, the first one wins; changedChannels lists the channels whose text moved', () => withStore((store) => {
  const guildId = 'g1';
  const cfg = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 };
  const known = { knownChannelIds: new Set(['c1', 'c2']) };
  store.updateChannel(guildId, 'c1', { purpose: 'alpha' });
  store.updateChannel(guildId, 'c2', { purpose: 'beta' });
  const result = applyMemoryUpdate(store, guildId, {
    channels: { c1: { purpose: 'alpha' }, c2: { purpose: 'gamma' } },
    note_reviews: [
      { target: 'c1', status: 'confirmed' }, { target: 'c2', status: 'updated' }, { target: 'guild', status: 'insufficient_evidence' },
      { target: 'c1', status: 'updated' }, { target: 'c9', status: 'bogus' }, 'junk', { status: 'confirmed' }, [], null, { target: '', status: 'confirmed' },
    ],
  }, cfg, new Set(), known);
  assert.deepEqual(result.noteReviews, { c1: 'confirmed', c2: 'updated', guild: 'insufficient_evidence' });
  assert.deepEqual(result.changedChannels, ['c2']);
  assert.equal(result.guildChanged, false);

  const none = applyMemoryUpdate(store, guildId, { guild: { patterns: 'νέο' }, note_reviews: 'όχι' }, cfg, new Set(), known);
  assert.deepEqual([none.noteReviews, none.changedChannels, none.guildChanged], [{}, [], true]);
}));

test('applyMemoryUpdate: a blank channel field never blanks the stored text', () => withStore((store) => {
  store.updateChannel('g1', 'c1', { purpose: 'alpha' });
  const result = applyMemoryUpdate(store, 'g1', { channels: { c1: { purpose: '  ', tone: '' } } }, { fieldChars: 400 }, new Set(), { knownChannelIds: new Set(['c1']) });
  assert.deepEqual([store.getChannel('g1', 'c1').purpose, result.channels, result.changedChannels], ['alpha', 0, []]);
}));

test('reconcileNoteReviews: only a confirmed review or an updated one with a real change earns the stamp; everything else is counted', () => {
  const out = reconcileNoteReviews({
    flagged: { channels: ['c1', 'c2', 'c3', 'c4'], guild: true },
    reviews: { c1: 'confirmed', c2: 'updated', c3: 'updated', c4: 'insufficient_evidence', c7: 'confirmed', guild: 'updated' },
    changedChannels: ['c2'],
    guildChanged: false,
  });
  assert.deepEqual(out.stamp, { channels: ['c1', 'c2'], guild: false });
  assert.deepEqual(out.counts, { updated: 1, confirmed: 1, insufficient: 1, missing: 0, identical: 2, unflagged: 1 });

  const guild = reconcileNoteReviews({ flagged: { channels: [], guild: true }, reviews: { guild: 'updated' }, changedChannels: [], guildChanged: true });
  assert.deepEqual(guild.stamp, { channels: [], guild: true });
});

test('reconcileNoteReviews: a flagged target without a review is missing and not stamped', () => {
  const out = reconcileNoteReviews({ flagged: { channels: ['c1'], guild: true }, reviews: {}, changedChannels: [], guildChanged: false });
  assert.deepEqual(out.stamp, { channels: [], guild: false });
  assert.equal(out.counts.missing, 2);
});

test('run: in a two-stage batch a guild patterns or starters brief queued for the voice model makes an updated guild review a real change', async () => {
  for (const [guild, stamped] of [[{ patterns: 'νέες συνήθειες' }, true], [{ starters: 'καλημέρα' }, true], [{}, false]]) {
    await withStoreAsync(async (store) => {
      const guildId = 'g1';
      for (const message of notesLines('c1', 20)) {
        touchMemory(store, guildId, message);
        store.pushBuffer(guildId, message, 100);
      }
      const marked = [];
      store.markNotesChecked = (...args) => marked.push(args);
      const hot = twoStageHot({ batchMessages: 20, minBatchMessages: 1, notesBatchLines: 8, notesMinMessages: 20, notesGuildMinMessages: 20 });
      const llm = recordingLlm({ guild, note_reviews: [{ target: 'guild', status: 'updated' }] });
      const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => NOTES_NOW });

      const { logs } = await withCapturedLogs(() => updater.run(guildId));
      const applied = logs.find((entry) => entry.msg === 'memory: update applied');
      assert.equal(applied.guild, false, 'the brief is not stored text yet');
      assert.equal('guildBriefQueued' in applied, false, 'no guildBriefQueued in the log line');
      assert.deepEqual(marked, stamped ? [[guildId, { channels: [], guild: true }, NOTES_NOW]] : [], JSON.stringify(guild));
      assert.deepEqual([applied.notesUpdated, applied.notesIdentical], stamped ? [1, 0] : [0, 1]);
    });
  }
});

test('buildMemoryRequest: a request built per stage from the tracked prompts and config.json leaves no {{placeholder}} unfilled', () => {
  const read = (name) => fs.readFileSync(new URL(`../prompts/${name}`, import.meta.url), 'utf8');
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const prompts = {
    memory: read('memory.md'),
    'memory-decide': read('memory-decide.md'),
    'character-card': read('character-card.md'),
    rules: read('rules.md'),
    labels: JSON.parse(read('labels.json')),
  };
  const member = '723456789012345678';
  const messages = [
    slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', authorId: member, authorName: 'Zoé', content: 'καλημέρα', ts: NOTES_NOW - HOUR_MS }),
    slimMessage({ id: 'm2', channelId: 'c1', channelName: 'general', authorId: 'self1', authorName: 'Nept', self: true, content: 'γεια', ts: NOTES_NOW - HOUR_MS + MINUTE_MS }),
  ];
  for (const stage of ['single', 'decide']) {
    const request = buildMemoryRequest({
      prompts,
      config: shipped,
      calibrator: createCalibrator(),
      profiles: { [member]: { names: ['Zoé'], character: 'ήσυχη', relationship: 'φίλες', interests: [], details: [], episodes: [{ date: '2026-01-19', what: 'έφερε γλυκά', weight: 2 }] } },
      guildMemory: { patterns: 'μιμίδια', injokes: ['ο βράχος'], self: ['μου αρέσει η βροχή'] },
      channels: { c1: notesChannel('general') },
      loreEntries: [{ title: 'Ο βράχος', keys: ['καλημέρα'], text: 'ένα παλιό αστείο', updatedAt: notesDaysAgo(3) }],
      recentLines: [{ id: 1, at: NOTES_NOW - 2 * HOUR_MS, addedAt: null, channelId: 'c1', text: 'έβρεξε', who: [], weight: 2 }],
      rosterProfiles: [{ id: '823456789012345678', names: ['Βράνος'], lastSeen: notesDaysAgo(1), aliases: [], interests: [], details: [] }],
      messages,
      selfName: 'Nept',
      nameOf: () => null,
      now: NOTES_NOW,
      stage,
    });
    assert.ok(request.shown === 2 && request.recentShown === 1 && request.rosterIds.length === 1, `${stage}: every block present`);
    for (const message of request.messages) {
      assert.ok(!message.content.includes('{{'), `${stage}: the ${message.role} message`);
    }
  }
});

test('analyze: a hot change to lore.textChars between two updates is picked up', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    let text = 'x'.repeat(200);
    const hot = { config: makeConfig({ lore: { textChars: 50 } }), prompts: { memory: 'sys', labels } };
    const llm = { complete: async () => ({ text: JSON.stringify({ lore: [{ title: 'Event', keys: ['event'], text }] }) }) };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);
    assert.equal(store.getLore(guildId)[0].text.length, Math.floor(50 * 1.25), 'a first write is clamped');

    // A rewrite is never cut: over the limit it is refused, within it taken whole.
    text = 'y'.repeat(150);
    await updater.analyze(guildId, [slimMessage({ id: 'm2' })]);
    assert.equal(store.getLore(guildId)[0].text, 'x'.repeat(62), 'over 50: refused');

    hot.config.lore.textChars = 150;
    await updater.analyze(guildId, [slimMessage({ id: 'm3' })]);
    assert.equal(store.getLore(guildId)[0].text, 'y'.repeat(150), 'within 150, read fresh on this call');
  });
});

test('analyze: a hot change to memory.clampTolerance between two updates is picked up', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const longText = 'x'.repeat(600);
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, fieldChars: 100, clampTolerance: 1 }, relationships: { textChars: 100 } }),
      prompts: { memory: 'sys', labels },
    };
    // `relationship`: a prose field a stream batch still writes (character/style need the portrait
    // refresh), clamped to relationships.textChars.
    let author = '1';
    const llm = { complete: async () => ({ text: JSON.stringify({ users: { [author]: { relationship: longText } } }) }) };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'nick' })]);
    assert.equal(store.getUser(guildId, '1').relationship.length, 100, 'tolerance 1 -- a hard limit');

    // The tolerance widens only a first write: another member's first text.
    hot.config.memory.clampTolerance = 2;
    author = '2';
    await updater.analyze(guildId, [slimMessage({ id: 'm2', authorId: '2', authorName: 'other' })]);
    assert.equal(store.getUser(guildId, '2').relationship.length, 200, 'tolerance 2, read fresh on this call');
  });
});

test('buildMemoryRequest: <new_messages> groups messages by channel with a heading on every switch', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  const messages = [
    slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', content: 'first', ts: base }),
    slimMessage({ id: 'm2', channelId: 'c2', channelName: 'random', content: 'second', ts: base + 60_000 }),
  ];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const generalIdx = user.indexOf('## #general (id:c1)');
  const randomIdx = user.indexOf('## #random (id:c2)');
  assert.ok(generalIdx !== -1 && randomIdx !== -1 && generalIdx < randomIdx);
});

// ---- analyze: description wiring --------------------------------------------
// The live analyzer never triggers a new describer request itself (there is
// no describer dependency left on createMemoryUpdater at all): it only reads
// whatever src/behavior/pipeline.js already warmed into the shared media cache,
// keyed by item id -- see src/memory/describe.js's cache shape.

test('analyze: features.mediaDescriptions off never renders a cached description, even when one exists', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    let seenUser = null;
    const llm = { complete: async (messages) => { seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    store.getMediaCache(guildId).a1 = { text: 'a cat', ts: Date.now() };

    const messages = [
      slimMessage({ id: 'm1', content: '', attachments: [{ id: 'a1', kind: 'image', name: 'pic.png', durationSec: null }] }),
    ];
    await updater.analyze(guildId, messages);

    assert.ok(!seenUser.includes('a cat'));
    assert.ok(seenUser.includes(labels.transcript.image));
  });
});

test('analyze: features.mediaDescriptions on renders a cached description via imageDescribed, no separate request', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = {
      config: makeConfig({ features: { mediaDescriptions: true } }),
      prompts: { memory: 'sys', labels },
    };
    const calibrator = createCalibrator();
    let seenUser = null;
    let llmCalls = 0;
    const llm = { complete: async (messages) => { llmCalls += 1; seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    store.getMediaCache(guildId).a1 = { text: 'a grey cat', ts: Date.now() };

    const messages = [
      slimMessage({ id: 'm1', content: '', attachments: [{ id: 'a1', kind: 'image', name: 'pic.png', durationSec: null }] }),
    ];
    await updater.analyze(guildId, messages);

    assert.equal(llmCalls, 1, 'only the one memory-update completion, no description request from analyze()');
    assert.ok(seenUser.includes(labels.transcript.imageDescribed.replace('{text}', 'a grey cat')));
  });
});

test('analyze: a cache miss (or nothing cached yet) renders the blind form, never a request', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = {
      config: makeConfig({ features: { mediaDescriptions: true } }),
      prompts: { memory: 'sys', labels },
    };
    const calibrator = createCalibrator();
    let seenUser = null;
    const llm = { complete: async (messages) => { seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    store.getMediaCache(guildId).a1 = { miss: true, ts: Date.now() };

    const messages = [
      slimMessage({ id: 'm1', content: '', attachments: [{ id: 'a1', kind: 'image', name: 'pic.png', durationSec: null }] }),
    ];
    await updater.analyze(guildId, messages);

    assert.ok(seenUser.includes(labels.transcript.image));
  });
});

test('analyze: a cached sticker description renders via stickerDescribed, keyed sticker:<id> -- no URL ever needed', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig({ features: { mediaDescriptions: true } }), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    let seenUser = null;
    const llm = { complete: async (messages) => { seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    store.getMediaCache(guildId)['sticker:s1'] = { text: 'a frog gives a thumbs up', ts: Date.now() };

    const messages = [slimMessage({ id: 'm1', content: '', stickers: [{ id: 's1', name: 'pepe', format: 1 }] })];
    await updater.analyze(guildId, messages);

    assert.ok(seenUser.includes(labels.transcript.stickerDescribed.replace('{name}', 'pepe').replace('{text}', 'a frog gives a thumbs up')));
  });
});

test('analyze: a Lottie sticker never looks up a cache entry, always the plain name form', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig({ features: { mediaDescriptions: true } }), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    let seenUser = null;
    const llm = { complete: async (messages) => { seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    // Even if a cache entry somehow existed under this key, a Lottie sticker must never use it.
    store.getMediaCache(guildId)['sticker:s1'] = { text: 'should never show', ts: Date.now() };

    const messages = [slimMessage({ id: 'm1', content: '', stickers: [{ id: 's1', name: 'wiggle', format: 3 }] })];
    await updater.analyze(guildId, messages);

    assert.ok(seenUser.includes(labels.transcript.sticker.replace('{name}', 'wiggle')));
    assert.ok(!seenUser.includes('should never show'));
  });
});

test('analyze: a cached emoji description renders via emojiDescribed, keyed emoji:<id>', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig({ features: { mediaDescriptions: true } }), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    let seenUser = null;
    const llm = { complete: async (messages) => { seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    store.getMediaCache(guildId)['emoji:e1'] = { text: 'a surprised cat face', ts: Date.now() };

    const messages = [slimMessage({ id: 'm1', content: 'nice :pog:', emojis: [{ id: 'e1', name: 'pog' }] })];
    await updater.analyze(guildId, messages);

    assert.ok(seenUser.includes(labels.transcript.emojiDescribed.replace('{name}', 'pog').replace('{text}', 'a surprised cat face')));
  });
});

test('analyze: a described link thumbnail renders via thumbnailDescribed, keyed by the id already stored (the stable hash)', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig({ features: { mediaDescriptions: true } }), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    let seenUser = null;
    const llm = { complete: async (messages) => { seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    store.getMediaCache(guildId)['link:abcd1234'] = { text: 'a cat plays piano', ts: Date.now() };

    const messages = [
      slimMessage({
        id: 'm1',
        content: '',
        links: [{ id: 'link:abcd1234', kind: 'link', name: 'Cool video', durationSec: null }],
      }),
    ];
    await updater.analyze(guildId, messages);

    assert.ok(seenUser.includes(labels.transcript.thumbnailDescribed.replace('{text}', 'a cat plays piano')));
  });
});

// ---- analyze: video states from the shared media cache ----------------------

/** Run analyze() over `messages` with `cacheEntries` preset; returns the user text the analyzer saw. */
async function analyzerTranscriptWithCache(cacheEntries, messages, features = { mediaDescriptions: true, videoDescriptions: true }) {
  let seenUser = null;
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig({ features }), prompts: { memory: 'sys', labels } };
    const llm = { complete: async (llmMessages) => { seenUser = llmMessages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    Object.assign(store.getMediaCache(guildId), cacheEntries);
    await updater.analyze(guildId, messages);
  });
  return seenUser;
}

const VIDEO_SLIM = slimMessage({
  id: 'm1',
  content: '',
  attachments: [{ id: 'v1', kind: 'video', name: 'clip.mp4', durationSec: 20 }],
});
const VIDEO_LINK_SLIM = slimMessage({
  id: 'm1',
  content: '',
  links: [{ id: 'video:url:0123456789abcdef', kind: 'link', name: 'A title', durationSec: null }],
});

test('analyze: a watched video in the cache renders videoWatched in the analyzer transcript', async () => {
  const seen = await analyzerTranscriptWithCache({ 'video:v1': { text: 'κάποιος χορεύει', ts: Date.now(), watched: true } }, [VIDEO_SLIM]);
  const watched = labels.transcript.videoWatched
    .replace('{name}', 'clip.mp4')
    .replace('{duration}', '0:20')
    .replace('{text}', 'κάποιος χορεύει');
  assert.ok(seen.includes(watched));
});

test('analyze: a watched video-site link renders linkWatched, keyed video:<link id>', async () => {
  const seen = await analyzerTranscriptWithCache(
    { 'video:video:url:0123456789abcdef': { text: 'un chat joue du piano', ts: Date.now(), watched: true } },
    [VIDEO_LINK_SLIM],
  );
  assert.ok(seen.includes(labels.transcript.linkWatched.replace('{text}', 'un chat joue du piano')));
});

test('analyze: a permanent limit renders as not watched with its reason', async () => {
  const seen = await analyzerTranscriptWithCache({ 'video:v1': { miss: true, ts: Date.now(), reason: 'length', durationSec: 600 } }, [VIDEO_SLIM]);
  const notWatched = labels.transcript.videoNotWatched
    .replace('{name}', 'clip.mp4')
    .replace('{duration}', '0:20')
    .replace('{reason}', labels.transcript.videoReason.length);
  assert.ok(seen.includes(notWatched));
});

test('analyze: a length miss that fits the length cap now (or of unknown length) is no limit, as the describer rules', async () => {
  for (const entry of [{ durationSec: 20 }, {}]) {
    let seenUser = null;
    await withStoreAsync(async (store) => {
      const hot = {
        config: makeConfig({ features: { mediaDescriptions: true }, media: { video: { maxSeconds: 60 } } }),
        prompts: { memory: 'sys', labels },
      };
      const llm = { complete: async (llmMessages) => { seenUser = llmMessages[1].content; return { text: '{}' }; } };
      const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
      store.getMediaCache('g1')['video:v1'] = { miss: true, ts: Date.now(), reason: 'length', ...entry };
      await updater.analyze('g1', [VIDEO_SLIM]);
    });
    assert.ok(seenUser.includes(labels.transcript.video.replace('{name}', 'clip.mp4').replace('{duration}', '0:20')), JSON.stringify(entry));
    assert.ok(!seenUser.includes(labels.transcript.videoReason.length), JSON.stringify(entry));
  }
});

test('analyze: an error miss or no entry renders the plain video form', async () => {
  for (const cache of [{ 'video:v1': { miss: true, ts: Date.now(), reason: 'error' } }, {}]) {
    const seen = await analyzerTranscriptWithCache(cache, [VIDEO_SLIM]);
    assert.ok(seen.includes(labels.transcript.video.replace('{name}', 'clip.mp4').replace('{duration}', '0:20')));
    assert.ok(!seen.includes('not watched'));
  }
});

test('analyze: videoDescriptions off, or mediaDescriptions off, never renders a cached video state', async () => {
  for (const features of [
    { mediaDescriptions: true, videoDescriptions: false },
    { mediaDescriptions: false, videoDescriptions: true },
  ]) {
    const seen = await analyzerTranscriptWithCache(
      { 'video:v1': { text: 'should never show', ts: Date.now(), watched: true } },
      [VIDEO_SLIM],
      features,
    );
    assert.ok(!seen.includes('should never show'));
  }
});

// ---- analyze: media inside a forwarded message (message snapshot) -----------

const FORWARD_SLIM = slimMessage({
  id: 'm1',
  content: '',
  forwardedFrom: 'news',
  forwarded: [
    {
      content: 'look at this',
      attachments: [
        { kind: 'image', name: 'pic.png', id: 'fa1', durationSec: null },
        { kind: 'video', name: 'clip.mp4', id: 'fv1', durationSec: 20 },
      ],
      links: [
        { kind: 'link', name: 'A video', id: 'video:url:fwd0123456789ab', durationSec: null },
        { kind: 'link', name: 'A page', id: 'fwd#e1', durationSec: null },
      ],
      stickers: [{ id: 'fs1', name: 'wave', format: 1 }],
      emojis: [{ id: 'fe1', name: 'hey' }],
    },
  ],
});

test('analyze: a forwarded picture, sticker and emoji render their cached descriptions inside the forward', async () => {
  const seen = await analyzerTranscriptWithCache(
    {
      fa1: { text: 'a forwarded cat', ts: Date.now() },
      'sticker:fs1': { text: 'a waving hand', ts: Date.now() },
      'emoji:fe1': { text: 'a smiling face', ts: Date.now() },
    },
    [FORWARD_SLIM],
  );
  assert.ok(seen.includes(labels.transcript.imageDescribed.replace('{text}', 'a forwarded cat')));
  assert.ok(seen.includes(labels.transcript.stickerDescribed.replace('{name}', 'wave').replace('{text}', 'a waving hand')));
  assert.ok(seen.includes(labels.transcript.emojiDescribed.replace('{name}', 'hey').replace('{text}', 'a smiling face')));
  // The forward wrapper itself, opened with the snapshot's own text.
  assert.ok(seen.includes('[forwarded from #news: look at this'));
});

test('analyze: a forwarded video attachment and video-site link render their cached video states', async () => {
  const seen = await analyzerTranscriptWithCache(
    {
      'video:fv1': { text: 'someone dances', ts: Date.now(), watched: true },
      'video:video:url:fwd0123456789ab': { text: 'a cat plays piano', ts: Date.now(), watched: true },
    },
    [FORWARD_SLIM],
  );
  const watched = labels.transcript.videoWatched
    .replace('{name}', 'clip.mp4')
    .replace('{duration}', '0:20')
    .replace('{text}', 'someone dances');
  assert.ok(seen.includes(watched));
  assert.ok(seen.includes(labels.transcript.linkWatched.replace('{text}', 'a cat plays piano')));
});

test('analyze: a forwarded link the web lookup read renders linkRead', async () => {
  const seen = await analyzerTranscriptWithConfig(
    { 'read:fwd#e1': { text: 'a recipe with three eggs', ts: Date.now() } },
    [FORWARD_SLIM],
    { features: { webLookup: true }, web: { links: { enabled: true } } },
  );
  assert.ok(seen.includes(labels.transcript.linkRead.replace('{text}', 'a recipe with three eggs')));
});

// ---- applyMemoryUpdate: channels --------------------------------------------

test('applyMemoryUpdate: merges purpose/topics/tone for a known channel id, clamped tolerantly to fieldChars', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchChannel(guildId, 'c1', { name: 'general', category: null, topic: null }, Date.now());
    const cfg = { fieldChars: 5, maxDetails: 2, maxInjokes: 2, maxSelfFacts: 2 };

    const update = { channels: { c1: { purpose: 'a long purpose text', topics: 'games', tone: 'chill' } } };
    const result = applyMemoryUpdate(store, guildId, update, cfg, new Set(), { knownChannelIds: new Set(['c1']) });

    assert.equal(result.channels, 1);
    const channel = store.getChannel(guildId, 'c1');
    // fieldChars 5 * the default tolerance 1.25 = 6, which lands exactly on the word
    // boundary right after "long" -- so the whole word is kept, not cut mid-word.
    assert.equal(channel.purpose, 'a long');
    assert.equal(channel.topics, 'games');
    assert.equal(channel.tone, 'chill');
  });
});

test('applyMemoryUpdate: rejects a channel id outside knownChannelIds', () => {
  withStore((store) => {
    const guildId = 'g1';
    const cfg = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 };

    const result = applyMemoryUpdate(store, guildId, { channels: { c999: { purpose: 'x' } } }, cfg, new Set(), { knownChannelIds: new Set(['c1']) });

    assert.equal(result.channels, 0);
    assert.equal(store.getChannel(guildId, 'c999'), null);
  });
});

const EARLIER_STAMP = '2000-01-01T00:00:00.000Z';

test('applyMemoryUpdate: a channel re-send identical after clamping counts 0 and leaves updatedAt alone', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchChannel(guildId, 'c1', { name: 'general', category: null, topic: null }, Date.now());
    const cfg = { fieldChars: 5, maxDetails: 2, maxInjokes: 2, maxSelfFacts: 2 };
    const known = { knownChannelIds: new Set(['c1']) };

    applyMemoryUpdate(store, guildId, { channels: { c1: { purpose: 'a long purpose text', tone: 'chill' } } }, cfg, new Set(), known);
    store.getChannel(guildId, 'c1').updatedAt = EARLIER_STAMP;

    // A different tail past the clamp lands on the same stored 'a long'.
    const again = { channels: { c1: { purpose: 'a long story, retold', tone: 'chill' } } };
    assert.equal(applyMemoryUpdate(store, guildId, again, cfg, new Set(), known).channels, 0);
    assert.equal(applyMemoryUpdate(store, guildId, { channels: { c1: {} } }, cfg, new Set(), known).channels, 0, 'no field is no change');
    assert.equal(store.getChannel(guildId, 'c1').updatedAt, EARLIER_STAMP);

    const changed = { channels: { c1: { purpose: 'a long purpose text', tone: 'loud' } } };
    assert.equal(applyMemoryUpdate(store, guildId, changed, cfg, new Set(), known).channels, 1);
    assert.notEqual(store.getChannel(guildId, 'c1').updatedAt, EARLIER_STAMP);
    assert.equal(store.getChannel(guildId, 'c1').tone, 'loud');
  });
});

test('applyMemoryUpdate: a known channel with no stored entry yet counts only when a field says something', () => {
  withStore((store) => {
    const guildId = 'g1';
    const cfg = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 };
    const known = { knownChannelIds: new Set(['c1', 'c2']) };

    assert.equal(applyMemoryUpdate(store, guildId, { channels: { c1: { purpose: '', tone: '' } } }, cfg, new Set(), known).channels, 0);
    assert.equal(store.getChannel(guildId, 'c1').updatedAt, null);
    assert.equal(applyMemoryUpdate(store, guildId, { channels: { c2: { purpose: 'memes' } } }, cfg, new Set(), known).channels, 1);
  });
});

// ---- applyMemoryUpdate ------------------------------------------------------

test('applyMemoryUpdate: clamps string and detail fields to the configured limits', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    const cfg = { fieldChars: 5, maxDetails: 2, maxInjokes: 2, maxSelfFacts: 2 };
    const longDetail = 'x'.repeat(250);
    const update = {
      users: { 1: { character: '0123456789', details: { add: [longDetail, 'b', 'c'] } } },
    };

    const result = applyMemoryUpdate(store, guildId, update, cfg, new Set(['1']), { portraitFields: true });

    assert.equal(result.users, 1);
    const profile = store.getUser(guildId, '1');
    // fieldChars 5 * the default tolerance 1.25 = 6, hard-cut (a single long word, no boundary).
    assert.equal(profile.character, '012345');
    assert.deepEqual(
      profile.details.map((d) => d.text),
      ['b', 'c'],
      'over maxDetails: same weight/lastSeen, so the earliest-added (the long one) is evicted first',
    );
  });
});

test('applyMemoryUpdate: rejects user ids outside knownUserIds', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    const cfg = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 };

    const result = applyMemoryUpdate(store, guildId, { users: { 999: { character: 'x' } } }, cfg, new Set(['1']));

    assert.equal(result.users, 0);
    assert.equal(result.droppedUsers, 1);
    assert.equal(store.getUser(guildId, '999'), null);
  });
});

test('applyMemoryUpdate: a field absent from the update leaves the stored value untouched', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    applyMemoryUpdate(store, guildId, { users: { 1: { relationship: 'old', style: 'calm' } } }, MEMORY_CFG, new Set(['1']), { portraitFields: true });

    const result = applyMemoryUpdate(store, guildId, { users: { 1: { style: 'new' } } }, MEMORY_CFG, new Set(['1']), { portraitFields: true });

    assert.equal(result.users, 1);
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.style, 'new');
    assert.equal(profile.relationship, 'old');
  });
});

test('applyMemoryUpdate: an empty-string prose field never blanks the stored value', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    applyMemoryUpdate(store, guildId, { users: { 1: { character: 'chatty' } } }, MEMORY_CFG, new Set(['1']), { portraitFields: true });

    applyMemoryUpdate(store, guildId, { users: { 1: { character: '' } } }, MEMORY_CFG, new Set(['1']), { portraitFields: true });

    assert.equal(store.getUser(guildId, '1').character, 'chatty');
  });
});

// ---- applyMemoryUpdate: the portrait fields ---------------------------------
// `character`/`style` are written only by profile.md: the warmup's person run and the portrait
// refresh pass `portraitFields: true`. A stream batch never does: whatever it returns for them is
// dropped and counted in `portraitDropped` (the `memory: update applied` line).

test('applyMemoryUpdate: character and style from a stream batch are dropped and counted', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Ἀλκμήνη', Date.now());
    store.touchUser(guildId, '2', 'Βράνος', Date.now());
    applyMemoryUpdate(store, guildId, { users: { 1: { character: 'μιλάει πολύ', style: 'σύντομα' } } }, MEMORY_CFG, new Set(['1']), { portraitFields: true });

    const result = applyMemoryUpdate(
      store,
      guildId,
      {
        users: {
          1: { character: 'γράφει άλλα τώρα', style: 'μακριές προτάσεις', relationship: 'φίλη' },
          2: { character: '   ', style: 'ήρεμο', details: { add: ['café au lait'] } },
        },
      },
      MEMORY_CFG,
      new Set(['1', '2']),
    );

    const first = store.getUser(guildId, '1');
    assert.equal(first.character, 'μιλάει πολύ', 'the stored portrait is untouched');
    assert.equal(first.style, 'σύντομα');
    assert.equal(first.relationship, 'φίλη', 'every other field still lands');
    const second = store.getUser(guildId, '2');
    assert.equal(second.style, '');
    assert.deepEqual(second.details.map((d) => d.text), ['café au lait']);
    assert.equal(result.portraitDropped, 3, 'a blank string is nothing to drop');
    assert.equal(result.users, 2);
  });
});

test('applyMemoryUpdate: with portraitFields (the portrait refresh, the warmup person run) character and style are stored', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Ἀλκμήνη', Date.now());

    const result = applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { character: 'μιλάει πολύ', style: 'σύντομα' } } },
      MEMORY_CFG,
      new Set(['1']),
      { portraitFields: true },
    );

    assert.equal(store.getUser(guildId, '1').character, 'μιλάει πολύ');
    assert.equal(store.getUser(guildId, '1').style, 'σύντομα');
    assert.equal(result.portraitDropped, 0);
  });
});

test('run: "memory: update applied" counts the portrait fields a stream batch tried to write', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const base = Date.now() - 60_000;
    store.touchUser(guildId, '1', 'Ἀλκμήνη', base);
    for (let i = 0; i < 4; i += 1) {
      store.pushBuffer(guildId, slimMessage({ id: `m${i}`, authorId: '1', authorName: 'Ἀλκμήνη', content: `γεια ${i}`, ts: base + i * 1000 }), 100);
    }
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 4, minBatchMessages: 1 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const llm = { complete: async () => ({ text: JSON.stringify({ users: { 1: { character: 'νέο πορτρέτο', style: 'νέο ύφος' } } }) }) };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));

    const applied = logs.find((entry) => entry.msg === 'memory: update applied');
    assert.ok(applied);
    assert.equal(applied.portraitDropped, 2);
    assert.equal(store.getUser(guildId, '1').character, '');
    assert.ok(!JSON.stringify(logs).includes('πορτρέτο'), 'counts only');
  });
});

test('applyPrivateUpdate: character and style are never stored and are counted in dropped.portrait', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, 'u1', 'Ἀλκμήνη', Date.now());
    const publicBefore = JSON.stringify(store.getUser(guildId, 'u1'));

    const result = applyPrivateUpdate(
      store,
      guildId,
      'u1',
      { users: { u1: { character: 'μιλάει πολύ', style: '  ', relationship: 'μυστική φίλη' } } },
      MEMORY_CFG,
    );

    assert.equal(result.dropped.portrait, 1);
    assert.equal(store.getPrivate(guildId, 'u1').relationship, 'μυστική φίλη');
    assert.equal(store.getPrivate(guildId, 'u1').character, undefined);
    assert.equal(JSON.stringify(store.getUser(guildId, 'u1')), publicBefore);
  });
});

// ---- applyMemoryUpdate: portrait refresh cues --------------------------------
// See docs/prompt-contract.md, "Data model": `character`/`style` stay
// plain prose, written only by profile.md (the warmup / a portrait
// refresh). The stream analyzer's `users.<id>.portrait` is a CUE, not an
// edit: never stored, only collected into `result.portraitRequests` for the
// caller (analyze()) to hand to an injected refresh callback.

test('applyMemoryUpdate: a portrait cue for a known user is collected, never stored', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const result = applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { portrait: 'now argues a lot, the stored portrait never mentions it' } } },
      MEMORY_CFG,
      new Set(['1']),
    );

    assert.deepEqual(result.portraitRequests, [{ userId: '1', reason: 'now argues a lot, the stored portrait never mentions it' }]);
    assert.equal(store.getUser(guildId, '1').character, '', 'never written to the profile');
  });
});

test('applyMemoryUpdate: a portrait cue is clamped to 200 characters', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    const cfg = { ...MEMORY_CFG, clampTolerance: 1 };

    const result = applyMemoryUpdate(store, guildId, { users: { 1: { portrait: 'x'.repeat(250) } } }, cfg, new Set(['1']));

    assert.equal(result.portraitRequests[0].reason.length, 200);
  });
});

test('applyMemoryUpdate: a portrait cue is tokenized like other prose', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    const result = applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { portrait: 'now argues with Bran (id:223456789012345678) a lot' } } },
      MEMORY_CFG,
      new Set(['1']),
    );

    assert.equal(result.portraitRequests[0].reason, 'now argues with <@223456789012345678> a lot');
  });
});

test('applyMemoryUpdate: an empty/whitespace-only or non-string portrait cue is dropped, not collected', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    for (const garbage of ['', '   ', null, 42, {}, []]) {
      const result = applyMemoryUpdate(store, guildId, { users: { 1: { portrait: garbage } } }, MEMORY_CFG, new Set(['1']));
      assert.deepEqual(result.portraitRequests, [], `garbage ${JSON.stringify(garbage)} must not be collected`);
    }
  });
});

test('applyMemoryUpdate: empty guild and self updates are no-ops', () => {
  withStore((store) => {
    const guildId = 'g1';
    const before = { ...store.getGuild(guildId) };
    const cfg = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 };

    const result = applyMemoryUpdate(
      store,
      guildId,
      { guild: { patterns: '', starters: '', injokes: [] }, self: [] },
      cfg,
      new Set(),
    );

    assert.equal(result.guild, false);
    assert.equal(result.self, false);
    assert.deepEqual(store.getGuild(guildId), before);
  });
});

test('applyMemoryUpdate: a guild re-send identical after clamping is guild: false and leaves updatedAt alone', () => {
  withStore((store) => {
    const guildId = 'g1';
    // fieldChars 4 -> patterns/starters clamp at 4 * 2 * 1.25 = 10 characters.
    const cfg = { fieldChars: 4, maxDetails: 15, maxInjokes: 2, maxSelfFacts: 20 };
    const first = { guild: { patterns: 'μιμίδια και γάτες', starters: 'καλημέρα', injokes: ['ο βράχος', 'café', 'extra'] } };
    assert.equal(applyMemoryUpdate(store, guildId, first, cfg, new Set()).guild, true);
    store.getGuild(guildId).updatedAt = EARLIER_STAMP;

    // Different tails past the clamps, a third injoke past maxInjokes that is a stored one again
    // (compared case-insensitively; a NEW one would enter at the cap): the same stored values.
    const again = { guild: { patterns: 'μιμίδια και σκύλοι', starters: 'καλημέρα', injokes: ['ο βράχος', 'café', 'Café'] } };
    assert.equal(applyMemoryUpdate(store, guildId, again, cfg, new Set()).guild, false);
    assert.equal(store.getGuild(guildId).updatedAt, EARLIER_STAMP);

    const changed = { guild: { starters: 'γεια σου' } };
    assert.equal(applyMemoryUpdate(store, guildId, changed, cfg, new Set()).guild, true);
    assert.notEqual(store.getGuild(guildId).updatedAt, EARLIER_STAMP);
    assert.equal(store.getGuild(guildId).starters, 'γεια σου');
  });
});

test('applyMemoryUpdate: garbage input changes nothing and never throws', () => {
  withStore((store) => {
    const guildId = 'g1';
    const cfg = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 };
    const before = { ...store.getGuild(guildId) };

    for (const garbage of [null, undefined, 'not an object', 42, [1, 2, 3]]) {
      const result = applyMemoryUpdate(store, guildId, garbage, cfg, new Set(['1']));
      for (const [key, value] of Object.entries(result)) {
        const empty = Array.isArray(value) ? value.length === 0 : value !== null && typeof value === 'object' && Object.keys(value).length === 0;
        assert.ok(value === 0 || value === false || empty, `${key} counts nothing`);
      }
    }
    assert.deepEqual(store.getGuild(guildId), before);
  });
});

test('applyMemoryUpdate: counts a member whose relationship text was written', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { relationship: 'we argued once, now she teases me' } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']));

    assert.equal(result.relationships, 1);
    assert.equal(store.getUser(guildId, '1').relationship, 'we argued once, now she teases me');
  });
});

test('applyMemoryUpdate: an empty, absent or unchanged relationship is not counted and leaves the stored text', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    applyMemoryUpdate(store, guildId, { users: { 1: { relationship: 'old friend' } } }, MEMORY_CFG, new Set(['1']));

    for (const raw of [{ relationship: '' }, { relationship: '   ' }, { style: 'calm' }, { relationship: 'old friend' }]) {
      const result = applyMemoryUpdate(store, guildId, { users: { 1: raw } }, MEMORY_CFG, new Set(['1']));
      assert.equal(result.relationships, 0, JSON.stringify(raw));
      assert.equal(store.getUser(guildId, '1').relationship, 'old friend');
    }
  });
});

// ---- applyMemoryUpdate: relationships -------------------------------------

const RELATIONSHIPS_CFG = { enabled: true, maxDeltaPerUpdate: 15, historySize: 10, damping: true, dampingPower: 1, now: Date.UTC(2026, 0, 1) };
const MEMORY_CFG = {
  fieldChars: 400,
  maxDetails: 15,
  maxInjokes: 15,
  maxSelfFacts: 20,
  maxInterests: 12,
  interestTopicChars: 40,
  interestNoteChars: 120,
};

test('applyMemoryUpdate: relationships enabled applies and clamps the affinity delta, counts changed scores', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { affinity: { delta: 999, reason: 'was really kind' } } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { relationships: RELATIONSHIPS_CFG });

    assert.equal(result.users, 1);
    assert.equal(result.affinity, 1);
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.affinity.score, 15, 'delta is clamped to maxDeltaPerUpdate');
    assert.equal(profile.affinity.reason, 'was really kind');
  });
});

test('applyMemoryUpdate: relationships.damping on damps the delta of an already one-sided score', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.adjustAffinity(guildId, '1', 50, 'a good start', { maxDelta: Infinity, historySize: 10, now: Date.now() });

    const update = { users: { 1: { affinity: { delta: 10, reason: 'kind again' } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { relationships: RELATIONSHIPS_CFG });

    // factor = 1 - 50/100 = 0.5 -> applied delta = 5, not the full 10.
    assert.equal(store.getUser(guildId, '1').affinity.score, 55);
  });
});

test('applyMemoryUpdate: relationships.dampingPower steepens/flattens the damping curve', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.adjustAffinity(guildId, '1', 60, 'a good start', { maxDelta: Infinity, historySize: 10, now: Date.now() });

    const update = { users: { 1: { affinity: { delta: 1, reason: 'kind again' } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { relationships: { ...RELATIONSHIPS_CFG, dampingPower: 2 } });

    // factor = (1 - 60/100) ** 2 = 0.16, not the plain power-1 factor of 0.4.
    assert.equal(store.getUser(guildId, '1').affinity.score, 60.16);
  });
});

test('applyMemoryUpdate: relationships.dampingPower garbage falls back to 1', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.adjustAffinity(guildId, '1', 60, 'a good start', { maxDelta: Infinity, historySize: 10, now: Date.now() });

    const update = { users: { 1: { affinity: { delta: 1, reason: 'kind again' } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { relationships: { ...RELATIONSHIPS_CFG, dampingPower: 'not a number' } });

    assert.equal(store.getUser(guildId, '1').affinity.score, 60.4);
  });
});

test('applyMemoryUpdate: relationships.damping: false applies the delta undamped', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.adjustAffinity(guildId, '1', 50, 'a good start', { maxDelta: Infinity, historySize: 10, now: Date.now() });

    const update = { users: { 1: { affinity: { delta: 10, reason: 'kind again' } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { relationships: { ...RELATIONSHIPS_CFG, damping: false } });

    assert.equal(store.getUser(guildId, '1').affinity.score, 60);
  });
});

test('applyMemoryUpdate: a zero/absent affinity delta does not count as a change', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { affinity: { delta: 0, reason: 'no change' } } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { relationships: RELATIONSHIPS_CFG });
    assert.equal(result.affinity, 0);

    const noAffinityField = applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { style: 'still chatty' } } },
      MEMORY_CFG,
      new Set(['1']),
      { relationships: RELATIONSHIPS_CFG },
    );
    assert.equal(noAffinityField.affinity, 0);
  });
});

test('applyMemoryUpdate: relationships disabled (or absent) ignores affinity entirely', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { affinity: { delta: 50, reason: 'should be ignored' } } } };
    const resultDisabled = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { relationships: { enabled: false } });
    assert.equal(resultDisabled.affinity, 0);
    assert.equal(store.getUser(guildId, '1').affinity.score, 0);

    const resultAbsent = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']));
    assert.equal(resultAbsent.affinity, 0);
    assert.equal(store.getUser(guildId, '1').affinity.score, 0);
  });
});

test('applyMemoryUpdate: a malformed affinity value is ignored, other fields still apply', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const result = applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { interests: { add: [{ topic: 'games', note: '' }] }, affinity: 'not an object' } } },
      MEMORY_CFG,
      new Set(['1']),
      { relationships: RELATIONSHIPS_CFG },
    );

    assert.equal(result.users, 1);
    assert.equal(result.affinity, 0);
    assert.equal(store.getUser(guildId, '1').interests[0].topic, 'games');
  });
});

/** `count` distinct stored-list items with a Greek stem. */
const listOf = (stem, count) => Array.from({ length: count }, (_, i) => `${stem} ${i + 1}`);

test('applyMemoryUpdate: a new in-joke appended to a full list enters, and the last carried one leaves', () => {
  withStore((store) => {
    const stored = listOf('το αστείο με τον βράχο', 15);
    store.updateGuild('g1', { injokes: stored });

    const result = applyMemoryUpdate(store, 'g1', { guild: { injokes: [...stored, 'η πάπια στο μπάνιο'] } }, MEMORY_CFG, new Set());

    assert.equal(result.guild, true);
    assert.deepEqual(store.getGuild('g1').injokes, [...stored.slice(0, 14), 'η πάπια στο μπάνιο']);
  });
});

test('applyMemoryUpdate: the same full in-joke list returned unchanged is no change and no write', () => {
  withStore((store) => {
    const stored = listOf('το αστείο με τον βράχο', 15);
    store.updateGuild('g1', { injokes: stored });
    store.getGuild('g1').updatedAt = EARLIER_STAMP;

    const result = applyMemoryUpdate(store, 'g1', { guild: { injokes: [...stored] } }, MEMORY_CFG, new Set());

    assert.equal(result.guild, false);
    assert.deepEqual(store.getGuild('g1').injokes, stored);
    assert.equal(store.getGuild('g1').updatedAt, EARLIER_STAMP, 'nothing written');
  });
});

test('applyMemoryUpdate: over the cap the new in-jokes are kept first, carried ones fill the rest in the returned order, compared as stored', () => {
  withStore((store) => {
    const zoe = '223456789012345678';
    store.touchUser('g1', zoe, 'Zoé', Date.now());
    store.updateGuild('g1', { injokes: ['α', 'β', 'γ', `η <@${zoe}> ξανά`] });
    const cfg = { ...MEMORY_CFG, maxInjokes: 4 };

    // `Γ` and the `Name (id:...)` form are carried ones: compared after the tokens and case-insensitively.
    const answer = ['β', 'νέο ένα', '  Γ ', 'νέο δύο', `η Zoé (id:${zoe}) ξανά`, 'α'];
    applyMemoryUpdate(store, 'g1', { guild: { injokes: answer } }, cfg, new Set([zoe]));
    assert.deepEqual(store.getGuild('g1').injokes, ['β', 'νέο ένα', 'Γ', 'νέο δύο'], 'two new, then the first two carried');

    // More new ones than the cap: the first of them, in the returned order.
    applyMemoryUpdate(store, 'g1', { guild: { injokes: ['β', 'καινούργιο 1', 'καινούργιο 2', 'καινούργιο 3', 'καινούργιο 4', 'καινούργιο 5'] } }, cfg, new Set());
    assert.deepEqual(store.getGuild('g1').injokes, listOf('καινούργιο', 4));
  });
});

test('applyMemoryUpdate: single-stage self facts follow the same rule at memory.maxSelfFacts, and self is true only when the list changed', () => {
  withStore((store) => {
    const stored = listOf('μου αρέσει η βροχή', 20);
    store.updateGuild('g1', { self: stored });

    const added = applyMemoryUpdate(store, 'g1', { self: [...stored, 'φυλάω έναν βάτραχο'] }, MEMORY_CFG, new Set());
    assert.equal(added.self, true);
    assert.deepEqual(store.getGuild('g1').self, [...stored.slice(0, 19), 'φυλάω έναν βάτραχο']);

    const kept = store.getGuild('g1').self;
    store.getGuild('g1').updatedAt = EARLIER_STAMP;
    const same = applyMemoryUpdate(store, 'g1', { self: [...kept] }, MEMORY_CFG, new Set());
    assert.equal(same.self, false, 'an unchanged list is no change');
    assert.equal(store.getGuild('g1').updatedAt, EARLIER_STAMP, 'nothing written');
  });
});

// ---- applyMemoryUpdate: self claims about a member ------------------------------

const SELF_DROP_LOG = 'memory: self claim about a member dropped';

test('applyMemoryUpdate: a single-stage self claim naming a member by token is dropped and counted, once in the log', async () => {
  await withStoreAsync(async (store) => {
    store.touchUser('g1', ZOE, 'Zoé', Date.now());
    // A known reference turns into the token; an unknown id keeps its marker, still a member.
    const answer = ['μου αρέσει η βροχή', `<@${ZOE}> είναι η αγαπημένη μου`, `η Zoé (id:${ZOE}) δεν βαριέται ποτέ`, 'ο Bran (id:323456789012345678) με κάνει να γελάω'];

    const { result, logs } = await withCapturedLogs(() => applyMemoryUpdate(store, 'g1', { self: answer }, MEMORY_CFG, new Set()));

    assert.deepEqual(store.getGuild('g1').self, ['μου αρέσει η βροχή'], 'the claim without a member lands');
    assert.equal(result.self, true);
    assert.equal(result.selfDropped, 3);
    const dropped = logs.filter((entry) => entry.msg === SELF_DROP_LOG);
    assert.equal(dropped.length, 1, 'one line per update');
    assert.equal(dropped[0].guildId, 'g1');
    assert.equal(dropped[0].count, 3);
    assert.ok(!JSON.stringify(dropped[0]).includes('αγαπημένη'), 'counts only, no text');
  });
});

test('applyMemoryUpdate: a single-stage self claim naming a stored member as a whole word, in any case, is dropped', async () => {
  await withStoreAsync(async (store) => {
    // Not an author of the batch: every stored profile's names count, the older ones too.
    store.touchUser('g1', '1', 'Ελένη', Date.UTC(2026, 0, 1));
    store.touchUser('g1', '1', 'Λένα', Date.UTC(2026, 0, 2));
    const answer = ['μου αρέσει η βροχή', 'η ΕΛΈΝΗ είναι η αγαπημένη μου', 'η λΈνα, πάντα χάος'];

    const { result, logs } = await withCapturedLogs(() => applyMemoryUpdate(store, 'g1', { self: answer }, MEMORY_CFG, new Set()));

    assert.deepEqual(store.getGuild('g1').self, ['μου αρέσει η βροχή']);
    assert.equal(result.selfDropped, 2);
    assert.equal(logs.filter((entry) => entry.msg === SELF_DROP_LOG).length, 1);
  });
});

test('applyMemoryUpdate: a member name inside a longer word is no self claim about them', async () => {
  await withStoreAsync(async (store) => {
    store.touchUser('g1', '1', 'Léa', Date.now());

    const { result, logs } = await withCapturedLogs(() => applyMemoryUpdate(store, 'g1', { self: ['μου αρέσει ο Léandre'] }, MEMORY_CFG, new Set()));

    assert.deepEqual(store.getGuild('g1').self, ['μου αρέσει ο Léandre']);
    assert.equal(result.selfDropped, 0);
    assert.equal(logs.filter((entry) => entry.msg === SELF_DROP_LOG).length, 0, 'nothing dropped, nothing logged');
  });
});

test('applyMemoryUpdate: a stored self fact naming a member is carried, only a new one is dropped', () => {
  withStore((store) => {
    store.touchUser('g1', ZOE, 'Zoé', Date.now());
    const stored = `<@${ZOE}> με έμαθε να παίζω σκάκι`;
    store.updateGuild('g1', { self: [stored] });

    const result = applyMemoryUpdate(store, 'g1', { self: [stored, 'μου αρέσει η βροχή', 'η Zoé είναι η αγαπημένη μου'] }, MEMORY_CFG, new Set());

    assert.deepEqual(store.getGuild('g1').self, [stored, 'μου αρέσει η βροχή'], 'a list carried forward is no add');
    assert.equal(result.selfDropped, 1);
  });
});
// ---- applyMemoryUpdate: episodes ----------------------------------------------

const EPISODES_CFG = { enabled: true, maxEpisodes: 20, maxNew: 3, now: Date.UTC(2026, 0, 1) };

test('applyMemoryUpdate: routes raw.episodes through store.addEpisodes, result gains the added count', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { episodes: [{ what: 'promised to help with the move' }] } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { episodes: EPISODES_CFG });

    assert.equal(result.episodes, 1);
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.episodes.length, 1);
    assert.equal(profile.episodes[0].what, 'promised to help with the move');
  });
});

test('applyMemoryUpdate: features.episodes off (episodes cfg absent) ignores raw.episodes entirely', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { episodes: [{ what: 'should be ignored' }] } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']));

    assert.equal(result.episodes, 0);
    assert.deepEqual(store.getUser(guildId, '1').episodes, []);
  });
});

test('applyMemoryUpdate: updateUser can never overwrite episodes via a normal profile field', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.addEpisodes(guildId, '1', [{ what: 'a real episode' }], { maxEpisodes: 20, maxNew: 3, now: 1000 });

    const update = { users: { 1: { character: 'nice', episodes: 'this is not routed through this key' } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { portraitFields: true });

    const profile = store.getUser(guildId, '1');
    assert.equal(profile.character, 'nice');
    assert.equal(profile.episodes.length, 1);
    assert.equal(profile.episodes[0].what, 'a real episode');
  });
});

/** Twenty stored weight-5 moments, added before EPISODES_CFG.now: a member at the default cap. */
function fullHeavyEpisodes() {
  return Array.from({ length: 20 }, (_, i) => ({ date: `2025-11-${String(i + 1).padStart(2, '0')}`, what: `βαριά στιγμή ${i + 1}`, weight: 5 }));
}
const SEED_EPISODES = { maxEpisodes: 20, maxNew: 20, now: Date.UTC(2025, 11, 1) };
const LIGHT_WHATS = Array.from({ length: 6 }, (_, i) => `ελαφριά στιγμή ${i + 1}`);

/** Six weight-1 moments over a member at the cap of heavy ones, in two batches of three
 * (EPISODES_CFG.maxNew) a day apart, each through `apply(update, episodes)`. Every light moment
 * is the lightest entry, so exactly the last K of them survive: K 4 would keep four, K 6 or
 * more all six, K 0 none. Returns the light moments kept, in stored order. */
function lightMomentsKept(apply, readEpisodes) {
  for (const [n, whats] of [LIGHT_WHATS.slice(0, 3), LIGHT_WHATS.slice(3)].entries()) {
    apply(whats.map((what) => ({ what, weight: 1 })), { ...EPISODES_CFG, now: EPISODES_CFG.now + n * DAY_MS });
  }
  const whats = readEpisodes().map((e) => e.what);
  assert.equal(whats.length, 20, 'the list stays at the cap');
  return whats.filter((what) => LIGHT_WHATS.includes(what));
}

test('applyMemoryUpdate: memory.keepNewestEpisodes reaches the merge', () => {
  for (const [cfg, keep] of [
    [{ ...MEMORY_CFG, keepNewestEpisodes: 2 }, 2],
    [{ ...MEMORY_CFG, keepNewestEpisodes: 0 }, 0],
  ]) {
    withStore((store) => {
      const guildId = 'g1';
      store.touchUser(guildId, '1', 'Ἑλένη', Date.now());
      store.addEpisodes(guildId, '1', fullHeavyEpisodes(), SEED_EPISODES);

      const kept = lightMomentsKept(
        (episodes, episodesCfg) =>
          applyMemoryUpdate(store, guildId, { users: { 1: { episodes } } }, cfg, new Set(['1']), { episodes: episodesCfg }),
        () => store.getUser(guildId, '1').episodes,
      );

      assert.deepEqual(kept, LIGHT_WHATS.slice(LIGHT_WHATS.length - keep), `keepNewestEpisodes ${cfg.keepNewestEpisodes}`);
    });
  }
});

test('applyPrivateUpdate: memory.keepNewestEpisodes reaches the private merge', () => {
  for (const [cfg, keep] of [
    [{ ...MEMORY_CFG, keepNewestEpisodes: 2 }, 2],
    [{ ...MEMORY_CFG, keepNewestEpisodes: 0 }, 0],
  ]) {
    withStore((store) => {
      const guildId = 'g1';
      store.touchUser(guildId, 'u1', 'Ἑλένη', Date.now());
      store.addPrivateEpisodes(guildId, 'u1', fullHeavyEpisodes(), SEED_EPISODES);

      const kept = lightMomentsKept(
        (episodes, episodesCfg) => applyPrivateUpdate(store, guildId, 'u1', { users: { u1: { episodes } } }, cfg, { episodes: episodesCfg }),
        () => store.getPrivate(guildId, 'u1').episodes,
      );

      const label = `keepNewestEpisodes ${cfg.keepNewestEpisodes}`;
      assert.deepEqual(kept, LIGHT_WHATS.slice(LIGHT_WHATS.length - keep), label);
      assert.deepEqual(store.getUser(guildId, 'u1').episodes, [], `${label}: the public profile is untouched`);
    });
  }
});

// ---- applyMemoryUpdate: lore ---------------------------------------------------

const LORE_CFG = { enabled: true, maxEntries: 500, now: Date.UTC(2026, 0, 1) };

test('applyMemoryUpdate: routes update.lore through store.setLore, result gains the upserted count', () => {
  withStore((store) => {
    const guildId = 'g1';
    const update = { lore: [{ title: 'The Flood', keys: ['flood'], text: 'It flooded once.' }] };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(), { lore: LORE_CFG });

    assert.equal(result.lore, 1);
    assert.equal(store.getLore(guildId).length, 1);
    assert.equal(store.getLore(guildId)[0].source, 'analyzer');
  });
});

test('applyMemoryUpdate: features.lore off (lore cfg absent) ignores update.lore entirely', () => {
  withStore((store) => {
    const guildId = 'g1';
    const update = { lore: [{ title: 'The Flood', keys: ['flood'], text: 'It flooded once.' }] };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set());

    assert.equal(result.lore, 0);
    assert.deepEqual(store.getLore(guildId), []);
  });
});

test('applyMemoryUpdate: lore never overwrites an existing owner entry', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.setLore(guildId, [{ title: 'Founders Day', keys: ['founders'], text: 'owner text', always: true }], {
      source: 'owner',
      now: 1000,
    });

    const update = { lore: [{ title: 'Founders Day', keys: ['founders'], text: 'analyzer overwrite attempt' }] };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(), { lore: LORE_CFG });

    assert.equal(store.getLore(guildId)[0].text, 'owner text');
  });
});

test('applyMemoryUpdate: an identical lore re-send counts 0 and leaves updatedAt alone; a changed one counts', () => {
  withStore((store) => {
    const guildId = 'g1';
    const later = { ...LORE_CFG, now: LORE_CFG.now + 3_600_000 };
    const flood = { title: 'The Flood', keys: ['flood'], text: 'It flooded once.' };
    const tale = { title: 'The Tale', keys: ['tale'], text: 'A tale was told.' };
    assert.equal(applyMemoryUpdate(store, guildId, { lore: [flood, tale] }, MEMORY_CFG, new Set(), { lore: LORE_CFG }).lore, 2);

    const result = applyMemoryUpdate(store, guildId, { lore: [flood, { ...tale, text: 'A tale was told twice.' }] }, MEMORY_CFG, new Set(), { lore: later });

    assert.equal(result.lore, 1, 'only the changed entry');
    const [storedFlood, storedTale] = store.getLore(guildId);
    assert.equal(storedFlood.updatedAt, new Date(LORE_CFG.now).toISOString());
    assert.equal(storedTale.updatedAt, new Date(later.now).toISOString());
  });
});

// ---- buildMemoryRequest: episodes in <existing_profiles> ----------------------

test('buildMemoryRequest: relationships/episodes on adds episodes {date, what, quote, weight} to existing profiles', () => {
  const config = makeConfig({ features: { episodes: true } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['nick'],
        character: '',
        interests: [],
        style: '',
        details: [],
        relationship: '',
        episodes: [{ date: '2026-01-01', what: 'said hi', quote: 'hi there', feeling: 'pleased', weight: 3, addedAt: 'x' }],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].episodes, [{ date: '2026-01-01', what: 'said hi', quote: 'hi there', weight: 3 }]);
});

test('buildMemoryRequest: features.episodes=false never adds episodes to existing profiles', () => {
  const config = makeConfig({ features: { episodes: false } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['nick'], character: '', interests: [], style: '', details: [], relationship: '', episodes: [{ date: '2026-01-01', what: 'x' }] } },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.equal(profiles['1'].episodes, undefined);
});

// ---- buildMemoryRequest: <existing_lore> ---------------------------------------

test('buildMemoryRequest: <existing_lore> lists all stored titles+keys and the full text of matched entries', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', content: 'remember the great flood', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];
  const loreEntries = [
    { id: 'a', title: 'The Flood', keys: ['flood'], text: 'It flooded once.', always: false, source: 'analyzer', weight: 3, updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', title: 'Unrelated Thing', keys: ['banana'], text: 'A banana story.', always: false, source: 'analyzer', weight: 3, updatedAt: '2026-01-02T00:00:00.000Z' },
  ];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
    loreEntries,
  });

  const user = llmMessages[1].content;
  const lore = JSON.parse(/<existing_lore>\n([\s\S]*?)\n<\/existing_lore>/.exec(user)[1]);
  assert.deepEqual(
    lore.titles.map((t) => t.title).sort(),
    ['The Flood', 'Unrelated Thing'],
  );
  assert.deepEqual(lore.matched, [{ title: 'The Flood', keys: ['flood'], text: 'It flooded once.' }]);
});

test('buildMemoryRequest: <existing_lore> titles are capped to the 200 most recently updated', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', content: 'nothing relevant', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];
  const loreEntries = Array.from({ length: 205 }, (_, i) => ({
    id: `e${i}`,
    title: `Entry ${i}`,
    keys: ['x'.repeat(3)],
    text: 'text',
    always: false,
    source: 'analyzer',
    weight: 3,
    updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
  }));

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
    loreEntries,
  });

  const user = llmMessages[1].content;
  const lore = JSON.parse(/<existing_lore>\n([\s\S]*?)\n<\/existing_lore>/.exec(user)[1]);
  assert.equal(lore.titles.length, 200);
  assert.ok(lore.titles.some((t) => t.title === 'Entry 204'), 'the most recently updated entry survives the cap');
  assert.ok(!lore.titles.some((t) => t.title === 'Entry 0'), 'the oldest updated entry is cut');
});

test('buildMemoryRequest: features.lore=false never renders <existing_lore>, even with stored entries', () => {
  const config = makeConfig({ features: { lore: false } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];
  const loreEntries = [{ id: 'a', title: 'X', keys: ['x'], text: 'text', always: false, source: 'analyzer', weight: 3, updatedAt: 'now' }];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
    loreEntries,
  });

  assert.ok(!llmMessages[1].content.includes('<existing_lore>'));
});

// ---- analyze: timeoutMs ---------------------------------------------------------

test('analyze: passes memory.timeoutMs (falling back to llm.timeoutMs) as options.timeoutMs', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, timeoutMs: 300000 } }),
      prompts: { memory: 'sys', labels },
    };
    const calibrator = createCalibrator();
    let seenOptions = null;
    const llm = { complete: async (messages, options) => { seenOptions = options; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);
    assert.equal(seenOptions.timeoutMs, 300000);
  });
});

test('analyze: falls back to llm.timeoutMs when memory.timeoutMs is unset', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } }; // makeConfig's memory has no timeoutMs
    const calibrator = createCalibrator();
    let seenOptions = null;
    const llm = { complete: async (messages, options) => { seenOptions = options; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);
    assert.equal(seenOptions.timeoutMs, hot.config.llm.timeoutMs);
  });
});

test('analyze: an empty or null models.base.extractor is unset -- the extractor default, never the voice model', async () => {
  await withStoreAsync(async (store) => {
    for (const model of ['', null]) {
      const hot = { config: makeConfig({ models: { base: { voice: 'x/y', extractor: model } } }), prompts: { memory: 'sys', labels } };
      let seenOptions = null;
      const llm = { complete: async (messages, options) => { seenOptions = options; return { text: '{}' }; } };
      const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
      await updater.analyze('g1', [slimMessage({ id: 'm1' })]);
      assert.equal(seenOptions.model, ROLE_DEFAULTS.extractor, JSON.stringify(model));
    }
  });
});

// ---- buildMemoryRequest: existing_profiles interests shape -----------------

test('buildMemoryRequest: existing_profiles interests are [{topic, note, seen, last}] ordered by weight, heaviest first', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['nick'],
        character: '',
        style: '',
        details: [],
        relationship: '',
        interests: [
          { topic: 'Anime', note: 'watches shonen', weight: 2, firstSeen: 'a', lastSeen: '2026-01-05T00:00:00.000Z' },
          { topic: 'Chess', note: '', weight: 5, firstSeen: 'a', lastSeen: null },
        ],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].interests, [
    { topic: 'Chess', note: '', seen: 5 },
    { topic: 'Anime', note: 'watches shonen', seen: 2, last: '2026-01-05' },
  ]);
});

test('buildMemoryRequest: existing_profiles details are [{id, text, seen, last}]', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['nick'],
        character: '',
        style: '',
        relationship: '',
        interests: [],
        details: [
          { id: 3, text: 'Owns a cat', weight: 2, firstSeen: 'a', lastSeen: '2026-01-05T00:00:00.000Z' },
          { id: 4, text: 'Plays guitar', weight: 1, firstSeen: 'a', lastSeen: null },
        ],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].details, [
    { id: 3, text: 'Owns a cat', seen: 2, last: '2026-01-05' },
    { id: 4, text: 'Plays guitar', seen: 1 },
  ]);
});

// ---- buildMemoryRequest: existing_profiles interests/details, top N by rank ---

test('buildMemoryRequest: existing_profiles interests show only the top memory.maxInterests by rank, in rank order', () => {
  const config = makeConfig({ memory: { ...makeConfig().memory, maxInterests: 2, interestHalfLifeDays: 180 } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['nick'],
        character: '',
        style: '',
        details: [],
        relationship: '',
        interests: [
          { topic: 'Ancient favorite', note: '', weight: 10, firstSeen: 'a', lastSeen: '2021-01-01T00:00:00.000Z' },
          { topic: 'Recent A', note: '', weight: 2, firstSeen: 'a', lastSeen: '2026-09-01T00:00:00.000Z' },
          { topic: 'Recent B', note: '', weight: 2, firstSeen: 'a', lastSeen: '2026-09-05T00:00:00.000Z' },
        ],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(
    profiles['1'].interests.map((i) => i.topic),
    ['Recent B', 'Recent A'],
    'the two most recent outrank the ancient heavy one and appear in rank order',
  );
});

test('buildMemoryRequest: existing_profiles details show only the top memory.maxDetails by rank, in rank order', () => {
  const config = makeConfig({ memory: { ...makeConfig().memory, maxDetails: 1, detailHalfLifeDays: 30 } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['nick'],
        character: '',
        style: '',
        relationship: '',
        interests: [],
        details: [
          { id: 1, text: 'Ancient favorite fact', weight: 10, firstSeen: 'a', lastSeen: '2021-01-01T00:00:00.000Z' },
          { id: 2, text: 'Fresh detail', weight: 1, firstSeen: 'a', lastSeen: '2026-09-20T00:00:00.000Z' },
        ],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].details.map((d) => d.id), [2], 'a short half-life lets the fresh detail outrank the ancient heavier one');
});

// ---- applyMemoryUpdate: interests / details, incremental shape --------------

test('applyMemoryUpdate: routes users.<id>.interests {add, update, remove} through store.applyProfileOps', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { interests: { add: [{ topic: 'Chess', note: 'plays weekly' }] } } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']));

    assert.equal(result.users, 1);
    assert.equal(result.interestsChanged, 1);
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.interests.length, 1);
    assert.equal(profile.interests[0].topic, 'Chess');
    assert.equal(profile.interests[0].note, 'plays weekly');
  });
});

test('applyMemoryUpdate: threads maxInterestsStored/interestHalfLifeDays/maxDetailsStored/detailHalfLifeDays through to store.applyProfileOps', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const ancientMs = Date.parse('2021-01-01T00:00:00.000Z');
    const cfgAncient = { ...MEMORY_CFG, maxInterests: 1, maxInterestsStored: 1, maxDetails: 1, maxDetailsStored: 1 };
    applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { interests: { add: [{ topic: 'Ancient favorite' }] }, details: { add: ['Ancient favorite fact'] } } } },
      cfgAncient,
      new Set(['1']),
      { timing: { seenAt: ancientMs } },
    );

    const recentMs = Date.parse('2026-09-20T00:00:00.000Z');
    const cfgDecay = {
      ...MEMORY_CFG,
      maxInterests: 1,
      maxInterestsStored: 1,
      interestHalfLifeDays: 30,
      maxDetails: 1,
      maxDetailsStored: 1,
      detailHalfLifeDays: 30,
    };
    applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { interests: { add: [{ topic: 'Fresh interest' }] }, details: { add: ['Fresh detail'] } } } },
      cfgDecay,
      new Set(['1']),
      { timing: { seenAt: recentMs } },
    );

    const profile = store.getUser(guildId, '1');
    assert.deepEqual(profile.interests.map((i) => i.topic), ['Fresh interest'], 'the storage cap (1) evicted the ancient interest by rank, not raw weight');
    assert.deepEqual(profile.details.map((d) => d.text), ['Fresh detail'], 'the storage cap (1) evicted the ancient detail by rank, not raw weight');
  });
});

test('applyMemoryUpdate: raw.details as {add, remove} is applied directly', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    applyMemoryUpdate(store, guildId, { users: { 1: { details: { add: ['old fact'] } } } }, MEMORY_CFG, new Set(['1']));

    const result = applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { details: { add: ['new fact'], remove: ['old fact'] } } } },
      MEMORY_CFG,
      new Set(['1']),
    );

    assert.equal(result.users, 1);
    assert.deepEqual(store.getUser(guildId, '1').details.map((d) => d.text), ['new fact']);
  });
});

// ---- observe -----------------------------------------------------------------

test('observe: ignores other bots entirely', () => {
  withStore((store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe('g1', slimMessage({ authorId: 'b1', authorName: 'SomeBot', bot: true, content: 'spam' }));

    assert.equal(store.getBuffer('g1').length, 0);
    assert.equal(store.getUser('g1', 'b1'), null);
  });
});

test('observe: strips attachment/link urls before buffering, keeps the item id for description-cache lookups', () => {
  withStore((store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe(
      'g1',
      slimMessage({
        content: 'look',
        attachments: [{ id: 'a1', kind: 'image', name: 'a.png', url: 'https://cdn.example/secret', durationSec: null }],
        links: [{ id: 'm1#e0', kind: 'gif', site: 'Tenor', title: 'cat', thumbnailUrl: 'https://t.tenor.com/x.png' }],
        stickers: [{ id: 's1', name: 'wow', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' }],
        emojis: [{ id: 'e1', name: 'pog', animated: false, url: 'https://cdn.discordapp.com/emojis/e1.webp?size=96' }],
      }),
    );

    const [buffered] = store.getBuffer('g1');
    assert.deepEqual(buffered.attachments, [{ kind: 'image', name: 'a.png', id: 'a1', durationSec: null }]);
    assert.equal('url' in buffered.attachments[0], false);
    assert.deepEqual(buffered.links, [{ kind: 'gif', name: 'cat', id: 'm1#e0', durationSec: null }]);
    assert.equal('url' in buffered.links[0], false);
    assert.equal('thumbnailUrl' in buffered.links[0], false);
    assert.deepEqual(buffered.stickers, [{ id: 's1', name: 'wow', format: 1 }]);
    assert.equal('url' in buffered.stickers[0], false);
    assert.deepEqual(buffered.emojis, [{ id: 'e1', name: 'pog' }]);
    assert.equal('url' in buffered.emojis[0], false);
  });
});

/** Every key of `value` (objects and arrays, recursively), for "no url anywhere" checks. */
function allKeys(value, out = []) {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, out));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.push(key);
      allKeys(inner, out);
    }
  }
  return out;
}

test('observe: keeps a forwarded snapshot\'s content and media ids, stripped like the top level -- no url anywhere', () => {
  withStore((store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe(
      'g1',
      slimMessage({
        content: '',
        forwardedFrom: 'news',
        forwarded: [
          {
            content: 'watch this',
            attachments: [{ id: 'fa1', kind: 'video', name: 'clip.mp4', url: 'https://cdn.example/fa1', size: 10, durationSec: 12 }],
            links: [
              {
                id: 'video:url:yt1',
                kind: 'link',
                site: 'YouTube',
                title: 'A video',
                text: 'desc',
                url: 'https://www.youtube.com/watch?v=abc',
                thumbnailUrl: 'https://i.ytimg.com/vi/abc/hq.jpg',
              },
            ],
            stickers: [{ id: 's9', name: 'wave', format: 1, url: 'https://media.discordapp.net/stickers/s9.png?size=160' }],
            emojis: [{ id: 'e9', name: 'hey', animated: false, url: 'https://cdn.discordapp.com/emojis/e9.webp?size=96' }],
          },
        ],
      }),
    );

    const [buffered] = store.getBuffer('g1');
    assert.equal(buffered.forwardedFrom, 'news');
    assert.deepEqual(buffered.forwarded, [
      {
        content: 'watch this',
        attachments: [{ kind: 'video', name: 'clip.mp4', id: 'fa1', durationSec: 12 }],
        links: [{ kind: 'link', name: 'A video', id: 'video:url:yt1', durationSec: null }],
        stickers: [{ id: 's9', name: 'wave', format: 1 }],
        emojis: [{ id: 'e9', name: 'hey' }],
      },
    ]);
    const keys = allKeys(buffered);
    assert.equal(keys.includes('url'), false);
    assert.equal(keys.includes('thumbnailUrl'), false);
  });
});

test('observe: touches the channel entry for both human and the persona\'s own messages', () => {
  withStore((store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe('g1', slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', authorId: '1', self: false }));
    updater.observe('g1', slimMessage({ id: 'm2', channelId: 'c1', channelName: 'general', authorId: 'self1', self: true, bot: false }));

    const channel = store.getChannel('g1', 'c1');
    assert.ok(channel);
    assert.equal(channel.name, 'general');
    assert.equal(channel.messageCount, 2);
  });
});

test('observe: touches the user profile for a human message but not for the persona\'s own', () => {
  withStore((store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe('g1', slimMessage({ authorId: '1', authorName: 'nick', self: false }));
    updater.observe('g1', slimMessage({ id: 'm2', authorId: 'self1', authorName: 'Nept', self: true, bot: false }));

    const profile = store.getUser('g1', '1');
    assert.ok(profile);
    assert.equal(profile.messageCount, 1);
    assert.deepEqual(profile.names, ['nick']);
    assert.equal(store.getUser('g1', 'self1'), null);
    assert.equal(store.getBuffer('g1').length, 2, 'both messages, including the persona\'s own, are buffered');
  });
});

test('observe: marks a message as direct only when told to', () => {
  withStore((store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe('g1', slimMessage({ id: 'm1' }), { direct: true });
    updater.observe('g1', slimMessage({ id: 'm2' }));

    const [first, second] = store.getBuffer('g1');
    assert.equal(first.direct, true);
    assert.equal(second.direct, false);
  });
});

// /nep pause: observe() must make the store dirty in NO way while paused.
test('observe: does nothing while store.state.data.paused is true -- no buffer, no user, no channel', () => {
  withStore((store) => {
    store.state.data.paused = true;
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe('g1', slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', authorId: '1', authorName: 'nick' }));

    assert.deepEqual(store.getBuffer('g1'), []);
    assert.equal(store.getUser('g1', '1'), null);
    assert.equal(store.getChannel('g1', 'c1'), null);
  });
});

test('observe: a buffer over its cap logs "memory: buffer trimmed" with the dropped count, no contents', async () => {
  await withStoreAsync(async (store) => {
    const hot = { config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 1 } }) };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const { logs } = await withCapturedLogs(() => {
      for (let i = 1; i <= 5; i += 1) updater.observe('g1', slimMessage({ id: `m${i}`, content: `κείμενο ${i}` }));
    });

    assert.deepEqual(store.getBuffer('g1').map((m) => m.id), ['m3', 'm4', 'm5'], 'capped at batchMessages * 3');
    const trimmed = logs.filter((entry) => entry.msg === 'memory: buffer trimmed');
    assert.equal(trimmed.length, 2, 'one line per push past the cap, none before it');
    for (const entry of trimmed) assert.equal(entry.dropped, 1);
    assert.ok(!JSON.stringify(logs).includes('κείμενο'), 'never message contents');
  });
});

// ---- run -----------------------------------------------------------------

test('run: happy path applies the update, shifts the buffer and flushes to disk', async () => {
  await withStoreAsync(async (store, dir) => {
    const guildId = 'g1';
    const base = Date.now() - 60_000;
    for (let i = 0; i < 4; i += 1) {
      store.pushBuffer(guildId, slimMessage({ id: `m${i}`, content: `hi ${i}`, ts: base + i * 1000 }), 100);
    }
    store.touchUser(guildId, '1', 'nick', base);

    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 4, minBatchMessages: 1 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const calibrator = createCalibrator();
    let seenOptions = null;
    const llm = {
      complete: async (messages, options) => {
        seenOptions = options;
        return { text: JSON.stringify({ users: { 1: { interests: { add: [{ topic: 'anime', note: '' }] } } }, guild: { patterns: 'friendly' }, self: [] }) };
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.run(guildId);

    assert.equal(store.getBuffer(guildId).length, 0);
    assert.equal(store.getUser(guildId, '1').interests[0].topic, 'anime');
    assert.equal(store.getGuild(guildId).patterns, 'friendly');
    assert.equal(seenOptions.maxOutputTokens, hot.config.memory.maxOutputTokens);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'guilds', guildId, 'users', '1.json'), 'utf8'));
    assert.equal(onDisk.interests[0].topic, 'anime');
  });
});

test('analyzerTemperature: memory.temperature when it is a number, else the one fallback', () => {
  assert.equal(analyzerTemperature({ memory: { temperature: 0.55 } }), 0.55);
  assert.equal(analyzerTemperature({ memory: { temperature: 0 } }), 0, 'zero is a usable temperature');
  const fallback = analyzerTemperature({ memory: {} });
  for (const config of [{ memory: { temperature: null } }, { memory: { temperature: 'warm' } }, {}, undefined]) {
    assert.equal(analyzerTemperature(config), fallback, JSON.stringify(config));
  }
});

test('run: memory.temperature is read at the call and sent with the analyzer request', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const base = Date.now() - 60_000;
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 2, minBatchMessages: 1, temperature: 0.55 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const seen = [];
    const llm = {
      complete: async (messages, options) => {
        seen.push(options.temperature);
        return { text: '{}' };
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    for (let i = 0; i < 2; i += 1) store.pushBuffer(guildId, slimMessage({ id: `a${i}`, ts: base + i * 1000 }), 100);
    await updater.run(guildId);
    hot.config.memory.temperature = 0.1; // a live edit reaches the next batch
    for (let i = 0; i < 2; i += 1) store.pushBuffer(guildId, slimMessage({ id: `b${i}`, ts: base + 10_000 + i * 1000 }), 100);
    await updater.run(guildId);

    assert.deepEqual(seen, [0.55, 0.1]);
  });
});

// /nep pause: waitIdle() lets /nep pause wait out a live-analyzer run()
// already in flight (an LLM call can take 30-90s) before it flushes and
// drops the store's caches -- see src/admin.js#cmdPause.
test('waitIdle: resolves only once the in-flight run() has finished, never starting a new one itself', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.pushBuffer(guildId, slimMessage({ id: 'm1' }), 100);

    let resolveLlm;
    const llm = {
      complete: () =>
        new Promise((resolve) => {
          resolveLlm = () => resolve({ text: JSON.stringify({ guild: { patterns: 'ok' } }) });
        }),
    };
    const hot = { config: makeConfig(), prompts: { memory: 'memory system prompt', labels } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const runPromise = updater.run(guildId);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let run() reach the pending llm.complete() call

    let idleResolved = false;
    const idlePromise = updater.waitIdle().then(() => {
      idleResolved = true;
    });
    assert.equal(idleResolved, false, 'must not resolve while the run is still in flight');

    resolveLlm();
    await runPromise;
    await idlePromise;
    assert.equal(idleResolved, true);
    assert.equal(store.getGuild(guildId).patterns, 'ok', 'the in-flight run applied its result before waitIdle resolved');
  });
});

// /nep pause: the live analyzer must never run while paused, even with a fully due buffer.
test('tick: does nothing while store.state.data.paused is true, even with a due buffer', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.state.data.paused = true;
    const base = Date.now();
    for (let i = 0; i < 4; i += 1) {
      store.pushBuffer(guildId, slimMessage({ id: `m${i}`, content: `hi ${i}`, ts: base + i * 1000 }), 100);
    }

    const hot = { config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 4, minBatchMessages: 1 } }) };
    let calls = 0;
    const llm = { complete: async () => { calls += 1; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    await updater.tick();

    assert.equal(calls, 0, 'the analyzer must never be called while paused');
    assert.equal(store.getBuffer(guildId).length, 4, 'the buffer is left exactly as it was');
  });
});

test('run: a failure keeps the buffer untouched and backs the guild off for 15 minutes', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const base = Date.now();
    for (let i = 0; i < 3; i += 1) {
      store.pushBuffer(guildId, slimMessage({ id: `m${i}`, content: `hi ${i}`, ts: base + i * 1000 }), 100);
    }

    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 3, minBatchMessages: 1 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const calibrator = createCalibrator();
    let calls = 0;
    const llm = {
      complete: async () => {
        calls += 1;
        throw new Error('boom');
      },
    };
    let nowValue = 1_000_000;
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept', now: () => nowValue });

    await updater.run(guildId);
    assert.equal(calls, 1);
    assert.equal(store.getBuffer(guildId).length, 3, 'buffer is untouched after a failed run');

    await updater.tick();
    assert.equal(calls, 1, 'still backed off: tick must not retry immediately');

    nowValue += 16 * 60_000;
    await updater.tick();
    assert.equal(calls, 2, 'backoff expired: tick retries');
  });
});

test('run: a truncated failure halves the next batch size for that guild; a success restores it', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const base = Date.now();
    for (let i = 0; i < 90; i += 1) {
      store.pushBuffer(guildId, slimMessage({ id: `m${i}`, content: `hi ${i}`, ts: base + i * 1000 }), 200);
    }

    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 15, minBatchMessages: 1 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const calibrator = createCalibrator();
    let call = 0;
    const llm = {
      complete: async () => {
        call += 1;
        if (call === 1) {
          // Cut mid-JSON by the output token cap: never going to parse.
          return {
            text: '{"users": {"1": {"interests": "cut off here',
            usage: { prompt_tokens: 1000, completion_tokens: 1000 },
            estimated: 2000,
            finishReason: 'length',
          };
        }
        return { text: JSON.stringify({ guild: { patterns: 'ok' } }) };
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.run(guildId); // fails 'truncated': halves the factor for next time
    assert.equal(store.getBuffer(guildId).length, 90, 'a failed run never shifts the buffer');

    await updater.run(guildId); // succeeds, but only at the halved size
    assert.equal(store.getBuffer(guildId).length, 70, 'only 20 (half of 30, floored at 20) were consumed, not 30');

    await updater.run(guildId); // succeeds again, size restored to normal
    assert.equal(store.getBuffer(guildId).length, 40, 'back to normal: 30 consumed this time, not another 20');
  });
});

test('run: a "token-limit" failure halves the next batch size too, instead of looping on the same buffer forever', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const base = Date.now();
    for (let i = 0; i < 90; i += 1) {
      store.pushBuffer(guildId, slimMessage({ id: `m${i}`, content: `hi ${i}`, ts: base + i * 1000 }), 200);
    }

    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 15, minBatchMessages: 1 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const calibrator = createCalibrator();
    let call = 0;
    const llm = {
      complete: async () => {
        call += 1;
        // Stored profiles pushed the request over the per-request cap: with the
        // buffer untouched, a plain back-off would retry this exact same batch
        // forever. Halving the batch size (same as 'truncated'/'bad-json')
        // actually makes progress instead.
        if (call === 1) throw new TokenLimitError('request estimated at 90000 tokens, cap is 50000');
        return { text: JSON.stringify({ guild: { patterns: 'ok' } }) };
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.run(guildId); // fails 'token-limit': halves the factor for next time
    assert.equal(store.getBuffer(guildId).length, 90, 'a failed run never shifts the buffer');

    await updater.run(guildId); // succeeds, but only at the halved size
    assert.equal(store.getBuffer(guildId).length, 70, 'only 20 (half of 30, floored at 20) were consumed, not 30');

    await updater.run(guildId); // succeeds again, size restored to normal
    assert.equal(store.getBuffer(guildId).length, 40, 'back to normal: 30 consumed this time, not another 20');
  });
});

/** How many buffered lines (content `line-<n>-end`) one analyzer request carried. */
function linesSent(llmMessages) {
  return (JSON.stringify(llmMessages).match(/line-\d+-end/g) ?? []).length;
}

/** A completion cut by the output cap: always reason 'truncated'. */
const TRUNCATED = { text: '{"users": {"1": {"interests": "cut off here', usage: { prompt_tokens: 10, completion_tokens: 10 }, estimated: 20, finishReason: 'length' };

test('tick: a truncated batch above the floor is retried smaller at the next tick; at the floor it backs off and is sent again after the back-off', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    let nowValue = 1_000_000_000;
    for (let i = 0; i < 40; i += 1) {
      store.pushBuffer(guildId, slimMessage({ id: `m${i}`, content: `line-${i}-end`, ts: nowValue + i }), 200);
    }
    // batchMessages 15: a normal batch takes 30, the first halving reaches the floor (20).
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 15, minBatchMessages: 1 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const sent = [];
    const llm = {
      complete: async (llmMessages) => {
        sent.push(linesSent(llmMessages));
        return TRUNCATED;
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowValue });

    const first = await withCapturedLogs(() => updater.tick());
    assert.deepEqual(sent, [30], 'the normal size goes first');
    const halved = first.logs.find((entry) => entry.msg === 'memory: update failed, halving the batch size for next time');
    assert.ok(halved, 'above the floor: halved');
    assert.equal(halved.atFloor, undefined);

    const second = await withCapturedLogs(() => updater.tick());
    assert.deepEqual(sent, [30, 20], 'retried smaller at the very next tick, no back-off above the floor');
    const backedOff = second.logs.find((entry) => entry.msg === 'memory: update failed, backing off');
    assert.ok(backedOff, 'at the floor: backed off');
    assert.equal(backedOff.reason, 'truncated');
    assert.equal(backedOff.atFloor, true);
    assert.equal(backedOff.backoffMs, 15 * MINUTE_MS);
    assert.ok(!second.logs.some((entry) => entry.msg === 'memory: update failed, halving the batch size for next time'), 'one line per failure');

    await updater.tick();
    nowValue += 15 * MINUTE_MS - 1;
    await updater.tick();
    assert.deepEqual(sent, [30, 20], 'the batch at the floor is not sent again before the back-off ends');

    nowValue += 1;
    await updater.tick();
    assert.deepEqual(sent, [30, 20, 20], 'sent again, still at the floor, once the back-off is over');
    assert.equal(store.getBuffer(guildId).length, 40, 'the stored buffer is never dropped');
  });
});

test('run: messages that arrive while the analyzer call is in flight are kept, even when the capped buffer trims the batch', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    // batchMessages 5: the buffer holds 15, a batch takes 10.
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 5, minBatchMessages: 1 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const base = Date.now();
    let updater;
    const llm = {
      complete: async () => {
        // Ten arrivals during the call: the capped buffer trims m0..m9 off its front.
        for (let i = 0; i < 10; i += 1) updater.observe(guildId, slimMessage({ id: `n${i}`, ts: base + 100 + i }));
        return { text: JSON.stringify({ guild: { patterns: 'ok' } }) };
      },
    };
    updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    for (let i = 0; i < 15; i += 1) updater.observe(guildId, slimMessage({ id: `m${i}`, ts: base + i }));

    await updater.run(guildId);

    const left = store.getBuffer(guildId).map((m) => m.id);
    assert.deepEqual(left, ['m10', 'm11', 'm12', 'm13', 'm14', 'n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9']);
  });
});

test('runPrivate: direct messages that arrive while the analyzer call is in flight are kept', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const base = Date.now();
    let updater;
    const llm = {
      complete: async () => {
        for (let i = 0; i < 4; i += 1) updater.observe(guildId, dmMessage({ id: `n${i}`, ts: base + 100 + i }), { private: 'u1' });
        return { text: JSON.stringify({ users: { u1: { relationship: 'note' } } }) };
      },
    };
    updater = createMemoryUpdater({ hot: privateHot({ batchMessages: 2, minBatchMessages: 1 }), store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    for (let i = 0; i < 6; i += 1) updater.observe(guildId, dmMessage({ id: `m${i}`, ts: base + i }), { private: 'u1' });

    await updater.runPrivate(guildId, 'u1');

    assert.deepEqual(store.getPrivateBuffer(guildId, 'u1').map((m) => m.id), ['m4', 'm5', 'n0', 'n1', 'n2', 'n3']);
  });
});

// ---- touchMemory -----------------------------------------------------------

test('touchMemory: bumps a human author into the channel\'s topWriters', () => {
  withStore((store) => {
    touchMemory(store, 'g1', slimMessage({ channelId: 'c1', channelName: 'general', authorId: '1', authorName: 'nick', self: false }));
    const channel = store.getChannel('g1', 'c1');
    assert.deepEqual(channel.topWriters, [{ id: '1', count: 1 }]);
  });
});

test('touchMemory: the persona\'s own message never counts toward topWriters', () => {
  withStore((store) => {
    touchMemory(store, 'g1', slimMessage({ channelId: 'c1', channelName: 'general', authorId: 'self1', self: true }));
    const channel = store.getChannel('g1', 'c1');
    assert.deepEqual(channel.topWriters, []);
  });
});

// ---- analyze -----------------------------------------------------------------

test('analyze: never touches the buffer, returns usage/estimated/result on success', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.pushBuffer(guildId, slimMessage({ id: 'm1' }), 100);
    store.touchUser(guildId, '1', 'nick', Date.now());

    const hot = {
      config: makeConfig(),
      prompts: { memory: 'memory system prompt', labels },
    };
    const calibrator = createCalibrator();
    const llm = {
      complete: async () => ({
        text: JSON.stringify({ users: { 1: { interests: { add: [{ topic: 'anime', note: '' }] } } } }),
        usage: { prompt_tokens: 111, completion_tokens: 22 },
        estimated: 130,
      }),
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const messages = [slimMessage({ id: 'mA', authorId: '1', content: 'hi' })];
    const outcome = await updater.analyze(guildId, messages);

    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.usage, { prompt_tokens: 111, completion_tokens: 22 });
    assert.equal(outcome.estimated, 130);
    assert.equal(outcome.result.users, 1);
    assert.equal(store.getUser(guildId, '1').interests[0].topic, 'anime');
    // The buffer, which analyze() never received, is untouched.
    assert.equal(store.getBuffer(guildId).length, 1);
  });
});

test('analyze: swallows a thrown error and returns { ok: false, error }', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = { complete: async () => { throw new Error('boom'); } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.usage, null);
    assert.ok(outcome.error instanceof Error);
    assert.equal(outcome.error.message, 'boom');
    assert.equal(outcome.reason, 'llm-error');
    assert.equal(outcome.detail, 'boom');
  });
});

test('analyze: a TokenLimitError from llm.complete reports reason "token-limit"', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = { complete: async () => { throw new TokenLimitError('request estimated at 90000 tokens, cap is 50000'); } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.usage, null);
    assert.equal(outcome.reason, 'token-limit');
    assert.equal(outcome.detail, 'request estimated at 90000 tokens, cap is 50000');
  });
});

test('analyze: a SectionsTooLargeError from buildMemoryRequest (required sections do not fit) also reports "token-limit", and never reaches the provider', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    // A huge memory prompt against a tiny per-request cap: buildMemoryRequest's
    // fitSections cannot fit even the required sections, and throws a
    // SectionsTooLargeError before llm.complete is ever called (this must
    // surface as its own reason, not a plain 'llm-error', so a caller can tell
    // it apart from a genuine, retryable failure).
    const hot = {
      config: makeConfig({ llm: { ...makeConfig().llm, maxRequestTokens: 50, safetyMargin: 1 } }),
      prompts: { memory: 'x'.repeat(2000), labels },
    };
    const calibrator = createCalibrator();
    let completeCalls = 0;
    const llm = { complete: async () => { completeCalls += 1; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.usage, null);
    assert.equal(outcome.estimated, 0);
    assert.equal(outcome.reason, 'token-limit');
    assert.match(outcome.detail, /required prompt sections exceed the token limit by \d+/);
    assert.equal(completeCalls, 0, 'the oversized request never reaches the provider — nothing was billed');
  });
});

test('analyze: an unparsable answer is reported and logged by its error name, never quoting the answer', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 1, minBatchMessages: 1 } }),
      prompts: { memory: 'sys', labels },
    };
    const llm = { complete: async () => ({ text: '{"users": she quit her job}', usage: {}, estimated: 0, finishReason: 'stop' }) };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);
    assert.equal(outcome.reason, 'bad-json');
    assert.equal(outcome.detail, 'SyntaxError');

    store.pushBuffer(guildId, slimMessage({ id: 'm2' }), 100);
    const { logs } = await withCapturedLogs(() => updater.run(guildId));
    assert.ok(logs.some((entry) => entry.msg.startsWith('memory: update failed') && entry.detail === 'SyntaxError'));
    assert.ok(!JSON.stringify(logs).includes('she quit'), 'the answer text never reaches a log line');
  });
});

test('analyze: a store error while applying a parsed answer is "apply-error", backs off instead of halving, logged by name only', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 15, minBatchMessages: 1 } }),
      prompts: { memory: 'sys', labels },
    };
    let calls = 0;
    const llm = {
      complete: async () => {
        calls += 1;
        return { text: JSON.stringify({ users: { 1: { relationship: 'κάτι' } } }), usage: { prompt_tokens: 5, completion_tokens: 5 }, estimated: 10 };
      },
    };
    let nowValue = 1_000_000;
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowValue });
    store.applyProfileOps = () => {
      throw new Error('disk refused /data/guilds/g1/users/1.json');
    };

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1' })]);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'apply-error');
    assert.equal(outcome.detail, 'Error');
    assert.deepEqual(outcome.usage, { prompt_tokens: 5, completion_tokens: 5 }, 'the completion was billed');

    for (let i = 0; i < 40; i += 1) store.pushBuffer(guildId, slimMessage({ id: `m${i}`, authorId: '1', ts: nowValue + i }), 100);
    const { logs } = await withCapturedLogs(() => updater.run(guildId));
    assert.equal(store.getBuffer(guildId).length, 40, 'nothing consumed');
    const failure = logs.find((entry) => entry.msg.startsWith('memory: update failed'));
    assert.ok(failure);
    assert.equal(failure.msg, 'memory: update failed, backing off', 'an apply error never halves the batch');
    assert.equal(failure.reason, 'apply-error');
    assert.ok(logs.some((entry) => entry.reason === 'apply-error' && entry.error === 'Error' && entry.msg !== failure.msg), 'its own count-only line');
    assert.ok(!JSON.stringify(logs).includes('disk refused'), 'the error message never reaches a log line');

    const callsBefore = calls;
    await updater.tick();
    assert.equal(calls, callsBefore, 'backed off');
  });
});

test('analyze: an error with an HTTP status (e.g. a 429 from the provider) surfaces it as outcome.status', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = {
      complete: async () => {
        const err = new Error('OpenRouter HTTP 429: too many tokens per day');
        err.statusCode = 429;
        throw err;
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'llm-error');
    assert.equal(outcome.status, 429);
  });
});

test('analyze: a completion that fails to parse still reports the real usage/estimated — it was billed', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = {
      complete: async () => ({
        text: 'not a JSON object at all',
        usage: { prompt_tokens: 80, completion_tokens: 10 },
        estimated: 90,
      }),
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.usage, { prompt_tokens: 80, completion_tokens: 10 });
    assert.equal(outcome.estimated, 90);
    assert.equal(outcome.result, null);
    assert.ok(outcome.error instanceof Error);
    assert.equal(outcome.reason, 'bad-json', 'no "{" at all is not a truncation, just garbage');
  });
});

test('analyze: a completion with no closing "}" for its first "{" reports reason "truncated"', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = {
      complete: async () => ({
        text: '{"users": {"1": {"interests": "a lot of anime and video games and',
        usage: { prompt_tokens: 4000, completion_tokens: 4000 },
        estimated: 8000,
        // finishReason omitted on purpose: the missing "}" alone must be enough
      }),
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'truncated');
    assert.deepEqual(outcome.usage, { prompt_tokens: 4000, completion_tokens: 4000 });
    assert.equal(outcome.estimated, 8000);
  });
});

test('analyze: finishReason "length" alone reports reason "truncated", even with a closing brace', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = {
      complete: async () => ({
        // A closing "}" is present, but it belongs to a nested object cut
        // mid-string by max_tokens -- JSON.parse still fails on it.
        text: '{"users": {"1": {"interests": "anime"}',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        estimated: 150,
        finishReason: 'length',
      }),
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'truncated');
  });
});

test('analyze: a request that fails to build (e.g. missing labels) reports usage: null, nothing was billed', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys' } }; // no labels: buildMemoryRequest throws
    const calibrator = createCalibrator();
    let calls = 0;
    const llm = { complete: async () => { calls += 1; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.usage, null);
    assert.equal(outcome.estimated, 0);
    assert.equal(calls, 0, 'the LLM is never called when the request cannot be built');
  });
});

test('analyze: never opts out of the daily request cap, relying on llm.complete\'s own default (true)', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    let seenOptions = null;
    const llm = { complete: async (messages, options) => { seenOptions = options; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.notEqual(seenOptions.countAgainstDailyCap, false);
  });
});

// ---- analyze: onPortraitRequest ----------------------------------------------
// See docs/prompt-contract.md, "Data model": a successful analyze()
// hands every collected `users.<id>.portrait` cue to the injected
// onPortraitRequest(guildId, userId, reason) callback; a later task wires the
// actual refresh. Never a store write on its own.

test('analyze: a portrait cue in the completion calls onPortraitRequest once for that user', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = { complete: async () => ({ text: JSON.stringify({ users: { 1: { portrait: 'now argues a lot' } } }) }) };
    const calls = [];
    const updater = createMemoryUpdater({
      hot,
      store,
      llm,
      calibrator,
      getSelfName: () => 'Nept',
      onPortraitRequest: (gid, userId, reason) => calls.push({ gid, userId, reason }),
    });

    await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'nick' })]);

    assert.deepEqual(calls, [{ gid: guildId, userId: '1', reason: 'now argues a lot' }]);
    assert.equal(store.getUser(guildId, '1').character, '', 'the cue is never written to the profile');
  });
});

test('analyze: no portrait cue in the completion never calls onPortraitRequest', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = { complete: async () => ({ text: '{}' }) };
    let called = false;
    const updater = createMemoryUpdater({
      hot,
      store,
      llm,
      calibrator,
      getSelfName: () => 'Nept',
      onPortraitRequest: () => {
        called = true;
      },
    });

    await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'nick' })]);

    assert.equal(called, false);
  });
});

test('analyze: an absent onPortraitRequest is fine, no throw, even with a portrait cue in the completion', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = { complete: async () => ({ text: JSON.stringify({ users: { 1: { portrait: 'now argues a lot' } } }) }) };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'nick' })]);

    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.result.portraitRequests, [{ userId: '1', reason: 'now argues a lot' }]);
  });
});

test('analyze: no memory prompt configured returns { ok: false } without calling the LLM', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: {} };
    const calibrator = createCalibrator();
    let calls = 0;
    const llm = { complete: async () => { calls += 1; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(calls, 0);
    assert.equal(outcome.reason, 'no-prompt');
  });
});

test('run: does nothing when prompts.memory is missing', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.pushBuffer(guildId, slimMessage(), 100);
    const hot = { config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 1, minBatchMessages: 1 } }), prompts: {} };
    const calibrator = createCalibrator();
    let calls = 0;
    const llm = { complete: async () => { calls += 1; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.run(guildId);

    assert.equal(calls, 0);
    assert.equal(store.getBuffer(guildId).length, 1);
  });
});

// ---- computeSeenAt -----------------------------------------------------------

test('computeSeenAt: per user, the newest timestamp of THAT user\'s own messages in the batch', () => {
  const messages = [
    slimMessage({ id: 'm1', authorId: '1', ts: 1000 }),
    slimMessage({ id: 'm2', authorId: '1', ts: 3000 }),
    slimMessage({ id: 'm3', authorId: '2', ts: 2000 }),
  ];
  const { seenAtByUser, seenAt } = computeSeenAt(messages);
  assert.equal(seenAtByUser.get('1'), 3000);
  assert.equal(seenAtByUser.get('2'), 2000);
  assert.equal(seenAt, 3000, 'the batch-wide fallback is the overall newest message');
});

test('computeSeenAt: the persona\'s own messages never contribute a per-user entry, but do count for the batch fallback', () => {
  const messages = [
    slimMessage({ id: 'm1', authorId: '1', ts: 1000 }),
    slimMessage({ id: 'm2', authorId: 'self1', self: true, ts: 9000 }),
  ];
  const { seenAtByUser, seenAt } = computeSeenAt(messages);
  assert.equal(seenAtByUser.has('self1'), false);
  assert.equal(seenAt, 9000);
});

// ---- applyMemoryUpdate: per-user seenAt (timing) -----------------------------

test('applyMemoryUpdate: timing.seenAtByUser dates a user\'s interest by their own message, not the wall clock', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const oldTs = Date.UTC(2020, 0, 1);
    const timing = { seenAtByUser: new Map([['1', oldTs]]), seenAt: oldTs };
    const update = { users: { 1: { interests: { add: [{ topic: 'Chess', note: '' }] } } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { timing });

    assert.equal(result.users, 1);
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.interests[0].firstSeen, new Date(oldTs).toISOString());
    assert.equal(profile.interests[0].lastSeen, new Date(oldTs).toISOString());
  });
});

// ---- analyze: dates interests/details by the message, not the wall clock ----
// analyze() accepts a batch of any age (a caller replaying old history feeds
// it through this exact same path) -- proving this here proves old messages
// get old dates too, without needing to script a full channel fetch.

test('analyze: dates a new interest/detail by the message\'s own (old) timestamp, not the wall clock "now"', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig({ memory: { ...makeConfig().memory, confirmGapHours: 12 } }), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = {
      complete: async () => ({
        text: JSON.stringify({
          users: { 1: { interests: { add: [{ topic: 'Chess', note: '' }] }, details: { add: ['Owns a cat'] } } },
        }),
      }),
    };
    // The wall clock this run happens to execute at is far in the future of the history being replayed.
    const wallClockNow = Date.UTC(2026, 8, 21);
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept', now: () => wallClockNow });

    const oldTs = Date.UTC(2020, 0, 1, 12, 0, 0); // years-old history, as a replayed batch would feed it
    const messages = [slimMessage({ id: 'old1', authorId: '1', authorName: 'nick', content: 'i love chess', ts: oldTs })];

    const outcome = await updater.analyze(guildId, messages);
    assert.equal(outcome.ok, true);

    const profile = store.getUser(guildId, '1');
    assert.equal(profile.interests[0].firstSeen, new Date(oldTs).toISOString(), 'dated by the message, not wallClockNow');
    assert.equal(profile.interests[0].lastSeen, new Date(oldTs).toISOString());
    assert.equal(profile.details[0].firstSeen, new Date(oldTs).toISOString());
    assert.notEqual(profile.interests[0].firstSeen, new Date(wallClockNow).toISOString());
  });
});

// ---- applyMemoryUpdate: id tokens on the way IN ---------------------------------
// See docs/prompt-contract.md, "Members are referred to by id, never
// by nickname" -- a `Name (id:123...)` the model writes in a free-text field
// becomes `<@id>` when the id is known (an author of the batch, or an
// existing stored profile); an unknown id is left exactly as written.

test('applyMemoryUpdate: character/style/relationship "Name (id:...)" becomes a token for a known id', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    const update = {
      users: {
        1: {
          character: 'gets along with Bran (id:223456789012345678)',
          style: 'quotes Bran (id:223456789012345678) a lot',
          relationship: 'trusts Bran (id:223456789012345678)',
        },
      },
    };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { portraitFields: true });

    const profile = store.getUser(guildId, '1');
    assert.equal(profile.character, 'gets along with <@223456789012345678>');
    assert.equal(profile.style, 'quotes <@223456789012345678> a lot');
    assert.equal(profile.relationship, 'trusts <@223456789012345678>');
  });
});

test('applyMemoryUpdate: an unknown id in "Name (id:...)" is left exactly as written', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());

    const update = { users: { 1: { character: 'mentions Ghost (id:99999999999999999)' } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { portraitFields: true });

    assert.equal(store.getUser(guildId, '1').character, 'mentions Ghost (id:99999999999999999)');
  });
});

test('applyMemoryUpdate: a detail text "Name (id:...)" is tokenized (both a bare-string and an object add item)', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { details: { add: ['a gift from Bran (id:223456789012345678)'] } } } },
      MEMORY_CFG,
      new Set(['1']),
    );
    assert.equal(store.getUser(guildId, '1').details[0].text, 'a gift from <@223456789012345678>');

    applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { details: { add: [{ text: 'borrowed from Bran (id:223456789012345678) too' }] } } } },
      MEMORY_CFG,
      new Set(['1']),
    );
    const texts = store.getUser(guildId, '1').details.map((d) => d.text);
    assert.ok(texts.includes('borrowed from <@223456789012345678> too'));
  });
});

test('applyMemoryUpdate: episode what/feeling are tokenized, quote is left verbatim', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    const update = {
      users: {
        1: {
          episodes: [
            {
              date: '2026-01-01',
              what: 'argued with Bran (id:223456789012345678)',
              quote: 'Bran (id:223456789012345678) is wrong',
              feeling: 'annoyed at Bran (id:223456789012345678)',
              weight: 3,
            },
          ],
        },
      },
    };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { episodes: EPISODES_CFG });

    const [episode] = store.getUser(guildId, '1').episodes;
    assert.equal(episode.what, 'argued with <@223456789012345678>');
    assert.equal(episode.feeling, 'annoyed at <@223456789012345678>');
    assert.equal(episode.quote, 'Bran (id:223456789012345678) is wrong', 'quote is verbatim, never tokenized');
  });
});

test('applyMemoryUpdate: guild patterns/starters/injokes are tokenized', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    const update = {
      guild: {
        patterns: 'people quote Bran (id:223456789012345678) constantly',
        starters: 'usually Bran (id:223456789012345678) starts it',
        injokes: ['"Bran (id:223456789012345678) did it again"'],
      },
    };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set());

    const guild = store.getGuild(guildId);
    assert.equal(guild.patterns, 'people quote <@223456789012345678> constantly');
    assert.equal(guild.starters, 'usually <@223456789012345678> starts it');
    assert.equal(guild.injokes[0], '"<@223456789012345678> did it again"');
  });
});

test('applyMemoryUpdate: lore text is tokenized, title and keys are never touched', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    const update = {
      lore: [{ title: 'The Bran (id:223456789012345678) Incident', keys: ['bran (id:223456789012345678)'], text: 'Bran (id:223456789012345678) broke the server once' }],
    };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(), { lore: LORE_CFG });

    const [entry] = store.getLore(guildId);
    assert.equal(entry.title, 'The Bran (id:223456789012345678) Incident', 'title is the identity, never tokenized');
    assert.deepEqual(entry.keys, ['bran (id:223456789012345678)'], 'keys are what people literally type, never tokenized');
    assert.equal(entry.text, '<@223456789012345678> broke the server once');
  });
});

// ---- applyMemoryUpdate: aliases -------------------------------------------------

test('applyMemoryUpdate: routes users.<id>.aliases {add, remove} through store.applyProfileOps', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());

    applyMemoryUpdate(store, guildId, { users: { 1: { aliases: { add: ['Ari'] } } } }, MEMORY_CFG, new Set(['1']));
    let profile = store.getUser(guildId, '1');
    assert.deepEqual(profile.aliases.map((a) => a.name), ['Ari']);

    applyMemoryUpdate(store, guildId, { users: { 1: { aliases: { remove: ['Ari'] } } } }, MEMORY_CFG, new Set(['1']));
    profile = store.getUser(guildId, '1');
    assert.deepEqual(profile.aliases, []);
  });
});

// ---- the alias roster (<known_members>) ------------------------------------------
// A guild batch also lists members with a stored profile who did NOT write in it, so an
// alias stated about one of them has an id to land on; such a member gets aliases only.

const ZOE = '223456789012345678';
const BRAN = '323456789012345678';
const CELIA = '423456789012345678';

/** A stored profile the way store.listUserProfiles hands it over: the roster pool. */
function poolProfile(id, names, lastSeen, aliases = []) {
  return { id, names, lastSeen, aliases, interests: [], details: [] };
}

/** One guild request with `pool` as the roster pool; `memory`/`llm` override makeConfig's own. */
function rosterRequest(pool, { memory = {}, llm = {}, messages, profiles = {}, privateChat } = {}) {
  const base = makeConfig();
  return buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config: makeConfig({ memory: { ...base.memory, ...memory }, llm: { ...base.llm, ...llm } }),
    calibrator: createCalibrator(),
    profiles,
    guildMemory: {},
    messages: messages ?? [slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: Date.UTC(2026, 0, 9, 12) })],
    selfName: 'Nept',
    rosterProfiles: pool,
    privateChat,
  });
}

/** The parsed `<known_members>` block of a request, or null when it is absent. */
function rosterOf(request) {
  const body = blockBody(request.messages[1].content, 'known_members');
  return body === null ? null : JSON.parse(body);
}

test('buildMemoryRequest: the alias roster lists non-author members with every stored display name and their shown aliases, newest lastSeen first', () => {
  const pool = [
    poolProfile('1', ['Aria'], '2026-01-09T12:00:00.000Z'),
    poolProfile(CELIA, ['Célia'], null),
    poolProfile(ZOE, ['Ζωή', 'Zoé-42%', 'zoé 42'], '2026-01-03T00:00:00.000Z', [
      { name: 'Ζωίτσα', weight: 2, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-02T00:00:00.000Z' },
      { name: 'Zo', weight: 1, firstSeen: '2020-01-01T00:00:00.000Z', lastSeen: '2020-01-01T00:00:00.000Z' },
    ]),
    poolProfile(BRAN, ['Βράνος'], '2026-01-05T00:00:00.000Z'),
  ];

  const request = rosterRequest(pool, { memory: { maxAliases: 1 } });

  assert.deepEqual(request.rosterIds, [BRAN, ZOE, CELIA], 'newest lastSeen first, an unknown lastSeen last');
  const roster = rosterOf(request);
  assert.deepEqual(roster, {
    [BRAN]: { names: ['Βράνος'] },
    [ZOE]: { names: ['Ζωή', 'Zoé-42%', 'zoé 42'], aliases: ['Ζωίτσα'] },
    [CELIA]: { names: ['Célia'] },
  });
  assert.ok(!('1' in roster), 'the batch author is not in the roster');
  const body = blockBody(request.messages[1].content, 'known_members');
  assert.ok(body.indexOf(BRAN) < body.indexOf(ZOE) && body.indexOf(ZOE) < body.indexOf(CELIA), 'rendered in the same order');
});

test('buildMemoryRequest: memory.aliasRosterSize caps the roster at the most recently seen members; 0 sends no roster', () => {
  const pool = [poolProfile(ZOE, ['Ζωή'], '2026-01-03T00:00:00.000Z'), poolProfile(BRAN, ['Βράνος'], '2026-01-05T00:00:00.000Z')];

  assert.deepEqual(rosterRequest(pool, { memory: { aliasRosterSize: 1 } }).rosterIds, [BRAN]);

  const off = rosterRequest(pool, { memory: { aliasRosterSize: 0 } });
  assert.deepEqual(off.rosterIds, []);
  assert.equal(rosterOf(off), null);
  assert.ok(!off.messages[1].content.includes('Βράνος'));
});

test('buildMemoryRequest: a private batch carries no alias roster', () => {
  const pool = [poolProfile(BRAN, ['Βράνος'], '2026-01-05T00:00:00.000Z')];
  const publicProfile = { id: '1', names: ['Aria'], interests: [], details: [], aliases: [] };

  const request = rosterRequest(pool, { privateChat: { publicProfile, now: Date.UTC(2026, 0, 9) } });

  assert.deepEqual(request.rosterIds, []);
  assert.equal(rosterOf(request), null);
  assert.ok(!request.messages[1].content.includes('Βράνος'));
});

test('buildMemoryRequest: the alias roster is fitted after the oldest transcript line and before the rest, entries that do not fit are skipped, the roster never causes a SectionsTooLargeError, and the kept ids are returned', () => {
  const calibrator = createCalibrator();
  const cost = (text) => calibrator.apply(estimateTokens(text)) + 2;
  const fixedCost =
    cost('x') +
    cost(`<existing_profiles>\n${JSON.stringify({})}\n</existing_profiles>`) +
    cost(`<existing_guild>\n${JSON.stringify({ patterns: '', starters: '', injokes: [], self: [], learned: [] })}\n</existing_guild>`) +
    cost(`<existing_channels>\n${JSON.stringify({})}\n</existing_channels>`);
  const base = Date.UTC(2026, 0, 9, 12);
  const messages = [0, 1, 2].map((i) =>
    slimMessage({ id: `m${i}`, authorId: '1', authorName: 'Aria', content: `message number ${i} ${'word '.repeat(30)}`, ts: base + i * 60_000 }),
  );
  const lineTexts = formatTranscript(messages, { timezone: 'UTC', gapMinutes: 20, maxChars: 800, selfName: 'Nept', mode: 'memory', labels }).map(
    (item) => item.text,
  );
  // The three lines' worth (the oldest carries the channel heading): a few roster entries, far from all 30.
  const room = cost(lineTexts[0]) + 2 * cost(lineTexts.at(-1));
  const pool = Array.from({ length: 30 }, (_, i) =>
    poolProfile(`6234567890123456${String(i).padStart(2, '0')}`, [`Μέλος ${String(i).padStart(2, '0')}`], new Date(base - i * 60_000).toISOString()),
  );
  const llm = { maxRequestTokens: fixedCost + room, safetyMargin: 1 };

  const without = rosterRequest([], { messages, llm });
  const withRoster = rosterRequest(pool, { messages, llm });

  assert.ok(without.shown >= 1);
  assert.ok(withRoster.rosterIds.length > 0 && withRoster.rosterIds.length < pool.length, 'trimmed, not dropped whole');
  assert.deepEqual(
    withRoster.rosterIds,
    pool.slice(0, withRoster.rosterIds.length).map((profile) => profile.id),
    'entries of one size: the most recently seen members survive',
  );
  assert.equal(withRoster.rosterCandidates, pool.length, 'every candidate is counted, sent or not');
  assert.deepEqual(Object.keys(rosterOf(withRoster)), withRoster.rosterIds, 'the ids returned are exactly the ones sent');
  assert.ok(withRoster.shown < without.shown, 'the roster takes its share before the rest of the transcript');
  assert.ok(withRoster.shown >= 1, 'but never the oldest line\'s');

  // Room for the required sections and the oldest line only: the roster is dropped, the request
  // still builds and carries that line.
  const bare = rosterRequest(pool, { messages, llm: { maxRequestTokens: fixedCost + cost(lineTexts[0]), safetyMargin: 1 } });
  assert.deepEqual(bare.rosterIds, []);
  assert.equal(rosterOf(bare), null);
  assert.equal(bare.consumed, 1);
  assert.equal(bare.deferred, 2);
});

test('buildMemoryRequest: a roster entry that does not fit is skipped while a shorter, older one is still sent, and the roster counts candidates and tokens', () => {
  const calibrator = createCalibrator();
  const cost = (text) => calibrator.apply(estimateTokens(text)) + 2;
  const fixedCost =
    cost('x') +
    cost(`<existing_profiles>\n${JSON.stringify({})}\n</existing_profiles>`) +
    cost(`<existing_guild>\n${JSON.stringify({ patterns: '', starters: '', injokes: [], self: [], learned: [] })}\n</existing_guild>`) +
    cost(`<existing_channels>\n${JSON.stringify({})}\n</existing_channels>`);
  const entry = (id, names) => `${JSON.stringify(id)}:${JSON.stringify({ names })}`;
  const longNames = Array.from({ length: 5 }, (_, i) => `Βράνος ο πολύ μακρύς ${i} ${'λ'.repeat(10)}`);
  const pool = [
    poolProfile(ZOE, ['Ζωή'], '2026-01-09T00:00:00.000Z'),
    poolProfile(BRAN, longNames, '2026-01-08T00:00:00.000Z'),
    poolProfile(CELIA, ['Célia'], '2026-01-07T00:00:00.000Z'),
  ];
  const sentCost = cost(entry(ZOE, ['Ζωή'])) + cost(entry(CELIA, ['Célia']));
  assert.ok(cost(entry(BRAN, longNames)) > cost(entry(CELIA, ['Célia'])) + 1, 'the middle entry is the heavy one');
  // The batch's one line, which the request carries before any roster entry.
  const [line] = formatTranscript([slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: Date.UTC(2026, 0, 9, 12) })], {
    timezone: 'UTC',
    gapMinutes: 20,
    maxChars: 800,
    selfName: 'Nept',
    mode: 'memory',
    labels,
  });

  const request = rosterRequest(pool, { llm: { maxRequestTokens: fixedCost + cost(line.text) + sentCost + 1, safetyMargin: 1 } });

  assert.deepEqual(request.rosterIds, [ZOE, CELIA], 'skipped, not cut at the first misfit: the roster may have gaps');
  assert.deepEqual(Object.keys(rosterOf(request)), [ZOE, CELIA]);
  assert.equal(request.rosterCandidates, 3, 'every candidate, sent or not');
  assert.equal(request.rosterTokens, sentCost, 'the tokens the sent entries took');

  const none = rosterRequest([]);
  assert.equal(none.rosterCandidates, 0);
  assert.equal(none.rosterTokens, 0);
});

test('buildMemoryRequest: memory.aliasRosterSize negative, fractional or not a number counts as missing', () => {
  const pool = Array.from({ length: 45 }, (_, i) =>
    poolProfile(`5234567890123456${String(i).padStart(2, '0')}`, [`Μέλος ${i}`], new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()),
  );

  const fallback = rosterRequest(pool).rosterIds.length;
  assert.ok(fallback > 0, 'a roster is sent');
  for (const aliasRosterSize of [-1, 1.5, '10']) {
    assert.equal(rosterRequest(pool, { memory: { aliasRosterSize } }).rosterIds.length, fallback, `aliasRosterSize ${JSON.stringify(aliasRosterSize)}`);
  }
});

test('buildMemoryRequest: the roster leaves out a profile with neither a name nor an alias, lists a duplicate id once and skips malformed alias items', () => {
  const alias = (name, day) => ({ name, weight: 1, firstSeen: `2026-01-0${day}T00:00:00.000Z`, lastSeen: `2026-01-0${day}T00:00:00.000Z` });
  const pool = [
    null,
    poolProfile(ZOE, ['Ζωή'], '2026-01-05T00:00:00.000Z', [null, { name: 7 }, alias('Ζωίτσα', 4)]),
    poolProfile(BRAN, [], '2026-01-09T00:00:00.000Z'), // nothing the analyzer could match
    poolProfile(CELIA, ['', '  '], '2026-01-08T00:00:00.000Z', [null]), // blank names, no usable alias
    poolProfile(ZOE, ['Ζωούλα'], '2026-01-09T00:00:00.000Z'), // the same id again
  ];
  // A malformed stored alias of a batch author is skipped in <existing_profiles> the same way.
  const profiles = { 1: { names: ['Aria'], aliases: [null, alias('Αρι', 3)] } };

  const request = rosterRequest(pool, { profiles });

  assert.deepEqual(request.rosterIds, [ZOE]);
  assert.deepEqual(rosterOf(request), { [ZOE]: { names: ['Ζωή'], aliases: ['Ζωίτσα'] } }, 'the first entry for an id is the one listed');
  assert.equal(request.rosterCandidates, 1);
  assert.deepEqual(JSON.parse(blockBody(request.messages[1].content, 'existing_profiles'))[1].aliases, ['Αρι']);
});

test('applyMemoryUpdate: an alias for a roster member who wrote nothing in the batch is stored, dated by the batch', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.UTC(2026, 0, 9, 12));
    store.touchUser(guildId, ZOE, 'Zoé-42%', Date.UTC(2026, 0, 1));
    const batchNewest = Date.UTC(2026, 0, 9, 12, 30);

    const result = applyMemoryUpdate(store, guildId, { users: { [ZOE]: { aliases: { add: ['Ζωή'] } } } }, MEMORY_CFG, new Set(['1']), {
      aliasOnlyIds: new Set([ZOE]),
      timing: computeSeenAt([slimMessage({ authorId: '1', ts: batchNewest })]),
    });

    const [alias] = store.getUser(guildId, ZOE).aliases;
    assert.equal(alias.name, 'Ζωή');
    assert.equal(alias.weight, 1);
    assert.equal(alias.firstSeen, new Date(batchNewest).toISOString(), 'dated by the batch\'s newest message');
    assert.equal(result.aliasOnly, 1);
    assert.equal(result.aliasesChanged, 1);
    assert.equal(result.users, 0, 'a roster member is not a written author');
    assert.equal(result.droppedUsers, 0);
  });
});

test('applyMemoryUpdate: every field except aliases for a roster member is dropped and counted', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, ZOE, 'Zoé', Date.now());
    const raw = {
      aliases: { add: ['Ζωίτσα'] },
      character: 'λέει πολλά',
      style: 'σύντομα',
      relationship: 'φίλη',
      interests: { add: [{ topic: 'κιθάρα', note: '' }] },
      details: { add: ['café au lait'] },
      affinity: { delta: 5, reason: 'καλή' },
      episodes: [{ what: 'είπε κάτι', weight: 2 }],
      portrait: 'μια νέα πλευρά',
    };

    const result = applyMemoryUpdate(store, guildId, { users: { [ZOE]: raw } }, MEMORY_CFG, new Set(['1']), {
      aliasOnlyIds: new Set([ZOE]),
      relationships: { enabled: true, maxDeltaPerUpdate: 15, historySize: 10 },
      episodes: { enabled: true, maxEpisodes: 20, maxNew: 3 },
    });

    const profile = store.getUser(guildId, ZOE);
    assert.deepEqual(profile.aliases.map((a) => a.name), ['Ζωίτσα']);
    assert.equal(profile.character, '');
    assert.equal(profile.style, '');
    assert.equal(profile.relationship, '');
    assert.deepEqual(profile.interests, []);
    assert.deepEqual(profile.details, []);
    assert.equal(profile.affinity.score, 0);
    assert.deepEqual(profile.episodes, []);
    assert.deepEqual(result.portraitRequests, []);
    assert.equal(result.droppedFields, 8, 'every key but aliases');
    assert.equal(result.affinity, 0);
    assert.equal(result.episodes, 0);
    assert.equal(result.aliasOnly, 1);
  });
});

test('applyMemoryUpdate: a roster id with no stored profile gets nothing, and no profile is created', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());

    const result = applyMemoryUpdate(store, guildId, { users: { [ZOE]: { aliases: { add: ['Ζωή'] } } } }, MEMORY_CFG, new Set(['1']), {
      aliasOnlyIds: new Set([ZOE]),
    });

    assert.equal(store.getUser(guildId, ZOE), null);
    assert.equal(result.droppedUsers, 1);
    assert.equal(result.aliasOnly, 0);
  });
});

test('applyMemoryUpdate: an entry for an id outside the authors and the roster is dropped and counted in droppedUsers', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, BRAN, 'Βράνος', Date.now()); // stored, but neither an author nor sent in the roster

    const result = applyMemoryUpdate(
      store,
      guildId,
      { users: { [BRAN]: { aliases: { add: ['Βράνι'] } }, 999: { character: 'x' }, 1: { style: 'ήρεμο' } } },
      MEMORY_CFG,
      new Set(['1']),
      { aliasOnlyIds: new Set([ZOE]) },
    );

    assert.equal(result.droppedUsers, 2);
    assert.equal(result.users, 1);
    assert.deepEqual(store.getUser(guildId, BRAN).aliases, []);
    assert.equal(store.getUser(guildId, '999'), null);
  });
});

test('applyMemoryUpdate: an alias holding a member token or an id marker is dropped, for an author and a roster member alike', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, ZOE, 'Zoé', Date.now());
    const refs = [`<@${ZOE}>`, `Ζωή <@!${ZOE}>`, `Zoé (id:${ZOE})`];

    applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { aliases: { add: [...refs, 'Αρι'] } }, [ZOE]: { aliases: { add: [...refs, 'Ζωίτσα'] } } } },
      MEMORY_CFG,
      new Set(['1']),
      { aliasOnlyIds: new Set([ZOE]) },
    );

    assert.deepEqual(store.getUser(guildId, '1').aliases.map((a) => a.name), ['Αρι']);
    assert.deepEqual(store.getUser(guildId, ZOE).aliases.map((a) => a.name), ['Ζωίτσα']);
  });
});

test('applyMemoryUpdate: an alias equal to a stored display name modulo case, spaces and punctuation is dropped', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, ZOE, 'Zoé-42%', Date.UTC(2026, 0, 1));
    store.touchUser(guildId, ZOE, 'Ζωή Π.', Date.UTC(2026, 0, 2)); // the current name; the earlier one stays stored

    applyMemoryUpdate(store, guildId, { users: { [ZOE]: { aliases: { add: ['zoé 42', 'ΖΩΉΠ', 'Ζωίτσα'] } } } }, MEMORY_CFG, new Set([ZOE]));

    assert.deepEqual(store.getUser(guildId, ZOE).aliases.map((a) => a.name), ['Ζωίτσα']);
  });
});

test('applyMemoryUpdate: a bare array under aliases adds only names not stored yet and never sights a stored alias', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.UTC(2026, 0, 1));
    const cfg = { ...MEMORY_CFG, confirmGapHours: 12 };
    applyMemoryUpdate(store, guildId, { users: { 1: { aliases: { add: ['Αρι'] } } } }, cfg, new Set(['1']), { timing: { seenAt: Date.UTC(2026, 0, 1) } });
    const stored = { ...store.getUser(guildId, '1').aliases[0] };

    // Four days later: an object-form add of 'αρι' would be a sighting (weight 2); the bare list is not.
    applyMemoryUpdate(store, guildId, { users: { 1: { aliases: ['αρι', 'Ariette', 'ariette'] } } }, cfg, new Set(['1']), {
      timing: { seenAt: Date.UTC(2026, 0, 5) },
    });

    const aliases = store.getUser(guildId, '1').aliases;
    assert.deepEqual(aliases.map((a) => a.name), ['Αρι', 'Ariette'], 'the unknown name is added once');
    assert.deepEqual(aliases[0], stored, 'the stored alias was not sighted: same weight, same dates');
    assert.equal(aliases[1].weight, 1);
  });
});

test('applyMemoryUpdate: a bare array never sights a stored alias the store clamped from a longer name', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.UTC(2026, 0, 1));
    const cfg = { ...MEMORY_CFG, confirmGapHours: 12 };
    const long = 'Αριάδνη η βασίλισσα των γατών του σπιτιού μας';
    assert.ok([...long].length > 40, 'longer than an alias may be');
    applyMemoryUpdate(store, guildId, { users: { 1: { aliases: { add: [long] } } } }, cfg, new Set(['1']), { timing: { seenAt: Date.UTC(2026, 0, 1) } });
    const stored = { ...store.getUser(guildId, '1').aliases[0] };
    assert.notEqual(stored.name, long, 'stored clamped');

    // Four days later the same long name comes back as a bare list: still not a sighting.
    const result = applyMemoryUpdate(store, guildId, { users: { 1: { aliases: [long] } } }, cfg, new Set(['1']), {
      timing: { seenAt: Date.UTC(2026, 0, 5) },
    });

    assert.deepEqual(store.getUser(guildId, '1').aliases, [stored]);
    assert.equal(result.aliasesChanged, 0);
    assert.equal(result.aliasesDropped, 1);
  });
});

test('applyMemoryUpdate: the alias guards also filter an update list, for an author and a roster member alike', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Célia-7', Date.now());
    store.touchUser(guildId, ZOE, 'Zoé-42%', Date.now());

    const result = applyMemoryUpdate(
      store,
      guildId,
      {
        users: {
          1: { aliases: { update: [`<@${ZOE}>`, `Zoé (id:${ZOE})`, 'célia 7', { name: 'Κελ' }, 'Κέλι'] } },
          [ZOE]: { aliases: { update: [`<@${BRAN}>`, `Βράνος (id:${BRAN})`, 'zoé 42', { name: 'Ζο' }, 'Ζωίτσα'] } },
        },
      },
      MEMORY_CFG,
      new Set(['1']),
      { aliasOnlyIds: new Set([ZOE]) },
    );

    assert.deepEqual(store.getUser(guildId, '1').aliases.map((a) => a.name), ['Κέλι']);
    assert.deepEqual(store.getUser(guildId, ZOE).aliases.map((a) => a.name), ['Ζωίτσα']);
    assert.equal(result.aliasesDropped, 8, 'a token, an id marker, the own name and a non-string, for each');
    assert.equal(result.aliasesChanged, 2);
    assert.equal(result.aliasOnly, 1);
  });
});

test('applyMemoryUpdate: without the alias-only set (the warmup and refresh callers) authors get every field and nobody else anything', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, ZOE, 'Zoé', Date.now());

    const result = applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { character: 'λέει πολλά', aliases: { add: ['Αρι'] } }, [ZOE]: { aliases: { add: ['Ζωή'] } } } },
      MEMORY_CFG,
      new Set(['1']),
      { timing: { seenAt: Date.now() }, portraitFields: true },
    );

    assert.equal(store.getUser(guildId, '1').character, 'λέει πολλά');
    assert.deepEqual(store.getUser(guildId, '1').aliases.map((a) => a.name), ['Αρι']);
    assert.deepEqual(store.getUser(guildId, ZOE).aliases, [], 'a stored member who is not an author gets nothing');
    assert.equal(result.users, 1);
    assert.equal(result.droppedUsers, 1);
    assert.equal(result.aliasOnly, 0);
  });
});

test('analyze: the request lists stored members who did not write in <known_members>, and an alias stated about one of them is stored', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const t = Date.UTC(2026, 0, 9, 12);
    store.touchUser(guildId, '1', 'Aria', t);
    store.touchUser(guildId, ZOE, 'Zoé-42%', t - 86_400_000);
    store.touchUser(guildId, BRAN, 'Βράνος', t - 2 * 86_400_000);
    let sent = null;
    const llm = {
      complete: async (messages) => {
        sent = messages;
        return { text: JSON.stringify({ users: { [ZOE]: { aliases: { add: ['Ζωή'] }, character: 'λέει πολλά' } } }) };
      },
    };
    const hot = { config: makeConfig(), prompts: { memory: 'memory system prompt', labels } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', content: 'η Ζωή είναι η zoé 42', ts: t })]);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.roster, 2);
    const roster = JSON.parse(blockBody(sent[1].content, 'known_members'));
    assert.deepEqual(Object.keys(roster), [ZOE, BRAN], 'the author is left out, the rest newest first');
    assert.deepEqual(roster[ZOE], { names: ['Zoé-42%'] });
    const zoe = store.getUser(guildId, ZOE);
    assert.deepEqual(zoe.aliases.map((a) => a.name), ['Ζωή']);
    assert.equal(zoe.character, '', 'only the alias is taken for a roster member');
    assert.equal(outcome.result.aliasOnly, 1);
    assert.equal(outcome.result.droppedFields, 1);
  });
});

test('analyze: only the roster members the request carried may receive an alias', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const t = Date.UTC(2026, 0, 9, 12);
    store.touchUser(guildId, '1', 'Aria', t);
    store.touchUser(guildId, ZOE, 'Zoé', t - 86_400_000);
    store.touchUser(guildId, BRAN, 'Βράνος', t - 2 * 86_400_000);
    const llm = {
      complete: async () => ({ text: JSON.stringify({ users: { [ZOE]: { aliases: { add: ['Ζωίτσα'] } }, [BRAN]: { aliases: { add: ['Βράνι'] } } } }) }),
    };
    const hot = { config: makeConfig({ memory: { ...makeConfig().memory, aliasRosterSize: 1 } }), prompts: { memory: 'memory system prompt', labels } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: t })]);

    assert.equal(outcome.roster, 1);
    assert.deepEqual(store.getUser(guildId, ZOE).aliases.map((a) => a.name), ['Ζωίτσα']);
    assert.deepEqual(store.getUser(guildId, BRAN).aliases, [], 'cut by the roster size: never sent, never written');
    assert.equal(outcome.result.droppedUsers, 1);
  });
});

test('analyze: a malformed alias item in a stored profile never fails the batch', async () => {
  await withStoreAsync(async (seed, dir) => {
    const guildId = 'g1';
    const t = Date.UTC(2026, 0, 9, 12);
    seed.touchUser(guildId, '1', 'Aria', t);
    seed.touchUser(guildId, ZOE, 'Zoé', t - 86_400_000);
    seed.flush();
    // A hand edit made while paused (the stored JSON is hand-editable): one alias item is null.
    for (const id of ['1', ZOE]) {
      const file = path.join(dir, 'guilds', guildId, 'users', `${id}.json`);
      const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
      profile.aliases = [null, { name: id === ZOE ? 'Ζωίτσα' : 'Αρι', weight: 1, firstSeen: '2026-01-02T00:00:00.000Z', lastSeen: '2026-01-02T00:00:00.000Z' }];
      fs.writeFileSync(file, JSON.stringify(profile));
    }
    const store = createStore({ dataDir: dir });
    let sent = null;
    const llm = {
      complete: async (messages) => {
        sent = messages;
        return { text: JSON.stringify({ users: { [ZOE]: { aliases: { add: ['Ζωή'] } } } }) };
      },
    };
    const hot = { config: makeConfig(), prompts: { memory: 'memory system prompt', labels } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: t })]);

    assert.equal(outcome.ok, true);
    assert.deepEqual(JSON.parse(blockBody(sent[1].content, 'known_members')), { [ZOE]: { names: ['Zoé'], aliases: ['Ζωίτσα'] } });
    assert.deepEqual(JSON.parse(blockBody(sent[1].content, 'existing_profiles'))[1].aliases, ['Αρι']);
    assert.equal(outcome.result.aliasOnly, 1);
  });
});

test('analyze: a stored profile list that cannot be read costs the batch its roster, never the batch', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const t = Date.UTC(2026, 0, 9, 12);
    store.touchUser(guildId, '1', 'Aria', t);
    store.touchUser(guildId, ZOE, 'Zoé', t - 86_400_000);
    store.listUserProfiles = () => {
      throw new TypeError("Cannot read properties of null (reading 'interests')");
    };
    let sent = null;
    const llm = {
      complete: async (messages) => {
        sent = messages;
        return { text: JSON.stringify({ users: { 1: { relationship: 'ήρεμη' }, [ZOE]: { aliases: { add: ['Ζωή'] } } } }) };
      },
    };
    const hot = { config: makeConfig(), prompts: { memory: 'memory system prompt', labels } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const { result: outcome, logs } = await withCapturedLogs(() =>
      updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: t })]),
    );

    assert.equal(outcome.ok, true);
    assert.equal(outcome.roster, 0);
    assert.equal(blockBody(sent[1].content, 'known_members'), null);
    assert.equal(store.getUser(guildId, '1').relationship, 'ήρεμη', 'the authors are still written');
    assert.deepEqual(store.getUser(guildId, ZOE).aliases, [], 'no roster sent: nobody else gets anything');
    const warning = logs.find((entry) => entry.msg === 'memory: alias roster left out');
    assert.ok(warning, 'the lost roster is logged');
    assert.equal(warning.reason, 'store-error');
    assert.equal(warning.error, 'TypeError', 'by the error\'s name only');
  });
});

// ---- buildMemoryRequest: id tokens resolved on the way OUT (analyzer mode) ------

function baseNameOf(names) {
  return (id) => names[id] ?? null;
}

test('buildMemoryRequest: existing_profiles character/style/relationship resolve <@id> to "name (id:...)"', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['Aria'],
        character: 'gets along with <@223456789012345678>',
        style: 'quotes <@223456789012345678> a lot',
        relationship: 'trusts <@223456789012345678>',
        interests: [],
        details: [],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
    nameOf: baseNameOf({ '223456789012345678': 'Bran' }),
  });

  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(llmMessages[1].content)[1]);
  assert.equal(profiles['1'].character, 'gets along with Bran (id:223456789012345678)');
  assert.equal(profiles['1'].style, 'quotes Bran (id:223456789012345678) a lot');
  assert.equal(profiles['1'].relationship, 'trusts Bran (id:223456789012345678)');
});

test('buildMemoryRequest: an id nameOf cannot resolve is left as the bare token', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['Aria'], character: 'knows <@223456789012345678>', interests: [], details: [] } },
    guildMemory: {},
    messages,
    selfName: 'Nept',
    nameOf: () => null,
  });

  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(llmMessages[1].content)[1]);
  assert.equal(profiles['1'].character, 'knows <@223456789012345678>');
});

test('buildMemoryRequest: a member renamed between write and read shows the NEW name in existing_profiles', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const requestFor = (name) =>
    buildMemoryRequest({
      prompts: { memory: 'x', labels },
      config,
      calibrator,
      profiles: { 1: { names: ['Aria'], character: 'knows <@223456789012345678>', interests: [], details: [] } },
      guildMemory: {},
      messages,
      selfName: 'Nept',
      nameOf: baseNameOf({ '223456789012345678': name }),
    });

  const before = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(requestFor('OldName').messages[1].content)[1]);
  assert.equal(before['1'].character, 'knows OldName (id:223456789012345678)');

  const after = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(requestFor('NewName').messages[1].content)[1]);
  assert.equal(after['1'].character, 'knows NewName (id:223456789012345678)');
});

test('buildMemoryRequest: existing_guild/existing_channels/existing_lore resolve <@id> tokens, lore titles/keys untouched', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0), content: 'bran incident' })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: { patterns: 'people quote <@223456789012345678>', starters: '<@223456789012345678> usually starts it', injokes: ['<@223456789012345678> did it again'], self: ['met <@223456789012345678> once'] },
    channels: { c1: { name: 'general', purpose: '<@223456789012345678> posts here', topics: 'stuff by <@223456789012345678>', tone: 'chill, <@223456789012345678> keeps it light' } },
    loreEntries: [{ id: 'l1', title: 'bran incident', keys: ['bran incident'], text: '<@223456789012345678> broke the server', updatedAt: 'x' }],
    messages,
    selfName: 'Nept',
    nameOf: baseNameOf({ '223456789012345678': 'Bran' }),
  });

  const user = llmMessages[1].content;
  const guildJson = JSON.parse(/<existing_guild>\n([\s\S]*?)\n<\/existing_guild>/.exec(user)[1]);
  assert.equal(guildJson.patterns, 'people quote Bran (id:223456789012345678)');
  assert.equal(guildJson.starters, 'Bran (id:223456789012345678) usually starts it');
  assert.equal(guildJson.injokes[0], 'Bran (id:223456789012345678) did it again');
  assert.equal(guildJson.self[0], 'met Bran (id:223456789012345678) once');

  const channelsJson = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(user)[1]);
  assert.equal(channelsJson.c1.purpose, 'Bran (id:223456789012345678) posts here');
  assert.equal(channelsJson.c1.topics, 'stuff by Bran (id:223456789012345678)');
  assert.equal(channelsJson.c1.tone, 'chill, Bran (id:223456789012345678) keeps it light');

  const loreJson = JSON.parse(/<existing_lore>\n([\s\S]*?)\n<\/existing_lore>/.exec(user)[1]);
  assert.equal(loreJson.matched[0].text, 'Bran (id:223456789012345678) broke the server');
  assert.equal(loreJson.matched[0].title, 'bran incident', 'title is never tokenized');
  assert.deepEqual(loreJson.matched[0].keys, ['bran incident'], 'keys are never tokenized');
});

test('buildMemoryRequest: existing_profiles shows aliases as a plain top-ranked list', () => {
  const config = makeConfig({ memory: { maxAliases: 1 } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['Aria'],
        interests: [],
        details: [],
        aliases: [
          { name: 'Ar', weight: 5, firstSeen: 'a', lastSeen: '2026-01-01T00:00:00.000Z' },
          { name: 'Ari', weight: 1, firstSeen: 'a', lastSeen: '2020-01-01T00:00:00.000Z' },
        ],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(llmMessages[1].content)[1]);
  assert.deepEqual(profiles['1'].aliases, ['Ar'], 'only the top maxAliases (1) by rank');
});

// ---- toTokens name-aware round trip through the real pipeline ------------------
// Reproduces the reported defect: a multi-word display name in the model's
// "Name (id:...)" fallback form must round-trip through
// applyMemoryUpdate -> buildMemoryRequest's analyzer view -> the model
// echoing that exact form back -> applyMemoryUpdate again, without growing
// or duplicating the name across several cycles.

test('applyMemoryUpdate + buildMemoryRequest: a multi-word display name round-trips stably across several analyzer cycles', () => {
  withStore((store) => {
    const guildId = 'g1';
    const authorId = '1';
    const otherId = '223456789012345678'; // "Al Sus"
    store.touchUser(guildId, authorId, 'Aria', Date.now());
    store.touchUser(guildId, otherId, 'Al Sus', Date.now());

    const batchAuthorNames = new Map([[otherId, 'Al Sus']]);
    const knownUserIds = new Set([authorId]);

    // Round 1: the model writes the fallback "Name (id:...)" form directly.
    applyMemoryUpdate(
      store,
      guildId,
      { users: { [authorId]: { character: `Al Sus (id:${otherId}) plays it` } } },
      MEMORY_CFG,
      knownUserIds,
      { batchAuthorNames, portraitFields: true },
    );
    assert.equal(store.getUser(guildId, authorId).character, `<@${otherId}> plays it`);

    const config = makeConfig();
    const calibrator = createCalibrator();
    const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];
    const nameOf = (id) => store.getUser(guildId, id)?.names?.[0] ?? null;

    function analyzerView() {
      const { messages: llmMessages } = buildMemoryRequest({
        prompts: { memory: 'x', labels },
        config,
        calibrator,
        profiles: { [authorId]: store.getUser(guildId, authorId) },
        guildMemory: {},
        messages,
        selfName: 'Nept',
        nameOf,
      });
      const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(llmMessages[1].content)[1]);
      return profiles[authorId].character;
    }

    const view1 = analyzerView();
    assert.equal(view1, `Al Sus (id:${otherId}) plays it`, 'the analyzer sees the full two-word name back, not "Al <@id> plays it"');

    // Round 2: the model echoes back EXACTLY what it was shown.
    applyMemoryUpdate(
      store,
      guildId,
      { users: { [authorId]: { character: view1 } } },
      MEMORY_CFG,
      knownUserIds,
      { batchAuthorNames, portraitFields: true },
    );
    assert.equal(store.getUser(guildId, authorId).character, `<@${otherId}> plays it`, 'no growth, no duplication after round 2');

    const view2 = analyzerView();
    assert.equal(view2, view1, 'the analyzer view is stable across cycles');

    // Round 3, for good measure.
    applyMemoryUpdate(
      store,
      guildId,
      { users: { [authorId]: { character: view2 } } },
      MEMORY_CFG,
      knownUserIds,
      { batchAuthorNames, portraitFields: true },
    );
    assert.equal(store.getUser(guildId, authorId).character, `<@${otherId}> plays it`, 'still stable after round 3');
    assert.equal(analyzerView(), view1);
  });
});

test('applyMemoryUpdate: namesOf recognises a batch author\'s current nick even before their stored profile has caught up', () => {
  withStore((store) => {
    const guildId = 'g1';
    const authorId = '1';
    const otherId = '223456789012345678';
    store.touchUser(guildId, authorId, 'Aria', Date.now());
    // The referenced member exists (known id) but their STORED name is still
    // the old one -- only the batch transcript saw the new nick.
    store.touchUser(guildId, otherId, 'OldNick', Date.now());

    const batchAuthorNames = new Map([[otherId, 'Al Sus']]);
    applyMemoryUpdate(
      store,
      guildId,
      { users: { [authorId]: { character: `Al Sus (id:${otherId}) plays it` } } },
      MEMORY_CFG,
      new Set([authorId]),
      { batchAuthorNames, portraitFields: true },
    );

    assert.equal(store.getUser(guildId, authorId).character, `<@${otherId}> plays it`, 'the batch nick, not just the stale stored name, is recognised');
  });
});

test('batchAuthorNamesMap: the author\'s latest message in the batch wins when their nick changed mid-batch', () => {
  const messages = [
    slimMessage({ id: 'm1', authorId: '1', authorName: 'OldNick', ts: 1000 }),
    slimMessage({ id: 'm2', authorId: '1', authorName: 'NewNick', ts: 2000 }),
    slimMessage({ id: 'm3', authorId: '2', authorName: 'Other', self: true, ts: 3000 }),
  ];
  const names = batchAuthorNamesMap(messages);
  assert.equal(names.get('1'), 'NewNick');
  assert.ok(!names.has('2'), 'the persona\'s own line never contributes a name');
});

// ---- analyze: pages the web lookup read, from the shared media cache ---------

/** Run analyze() with `cacheEntries` preset and a given config; returns the user text the analyzer saw. */
async function analyzerTranscriptWithConfig(cacheEntries, messages, configOverrides) {
  let seenUser = null;
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(configOverrides), prompts: { memory: 'sys', labels } };
    const llm = { complete: async (llmMessages) => { seenUser = llmMessages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    Object.assign(store.getMediaCache(guildId), cacheEntries);
    await updater.analyze(guildId, messages);
  });
  return seenUser;
}

const LINK_SLIM = slimMessage({
  id: 'm1',
  content: '',
  links: [{ id: 'm1#e0', kind: 'link', name: 'Crêpes', durationSec: null }],
});

test('analyze: a page the web lookup read renders linkRead, keyed read:<link id>', async () => {
  const seen = await analyzerTranscriptWithConfig(
    { 'read:m1#e0': { text: 'une recette, trois œufs', ts: Date.now() } },
    [LINK_SLIM],
    { features: { webLookup: true }, web: { links: { enabled: true } } },
  );
  assert.ok(seen.includes(labels.transcript.linkRead.replace('{text}', 'une recette, trois œufs')));
});

test('analyze: a read miss, no entry, webLookup off/missing or links disabled never renders a read', async () => {
  const hit = { 'read:m1#e0': { text: 'should never show', ts: Date.now() } };
  const cases = [
    [{ 'read:m1#e0': { miss: true, ts: Date.now(), reason: 'http' } }, { features: { webLookup: true } }],
    [{}, { features: { webLookup: true } }],
    [hit, { features: { webLookup: false } }],
    [hit, { features: {} }],
    [hit, { features: { webLookup: true }, web: { links: { enabled: false } } }],
  ];
  for (const [cache, config] of cases) {
    const seen = await analyzerTranscriptWithConfig(cache, [LINK_SLIM], config);
    assert.ok(!seen.includes('should never show'));
    assert.ok(!seen.includes(labels.transcript.linkRead.replace('{text}', '')));
  }
});

// ---- guild.learned: things people taught the persona ---------------------------

const TEACHER_A = '322222222222222222';
const TEACHER_B = '422222222222222222';
const STRANGER = '622222222222222222';
const LEARNED_AT = Date.UTC(2026, 8, 21, 12, 0, 0);

function learnedRequest(guildMemory, memory, nameOf) {
  return buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config: makeConfig(memory ? { memory } : {}),
    calibrator: createCalibrator(),
    profiles: {},
    guildMemory,
    messages: [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })],
    selfName: 'Nept',
    nameOf,
  });
}

function existingGuildOf(request) {
  return JSON.parse(/<existing_guild>\n([\s\S]*?)\n<\/existing_guild>/.exec(request.messages[1].content)[1]);
}

test('buildMemoryRequest: existing_guild learned is [{id, text, from, seen, last}], top memory.maxLearned by rank, tokens resolved', () => {
  const guildMemory = {
    learned: [
      { id: 1, text: 'forgotten one', weight: 1, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' },
      { id: 2, text: 'the kettle is called Ὠκεανός', weight: 5, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-10T08:00:00.000Z', from: `<@${TEACHER_A}>` },
      { id: 3, text: `pizza with <@${TEACHER_B}> on Fridays`, weight: 3, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-10T08:00:00.000Z' },
      { id: 4, text: 'café closes at nine', weight: 2, firstSeen: '2026-09-12T00:00:00.000Z', lastSeen: null, from: `<@${STRANGER}>` },
    ],
    learnedNextId: 5,
  };
  const nameOf = baseNameOf({ [TEACHER_A]: 'Aurélie', [TEACHER_B]: 'Björn' });
  const view = existingGuildOf(learnedRequest(guildMemory, { ...makeConfig().memory, maxLearned: 3, learnedHalfLifeDays: 720 }, nameOf)).learned;

  assert.deepEqual(view, [
    { id: 2, text: 'the kettle is called Ὠκεανός', from: `Aurélie (id:${TEACHER_A})`, seen: 5, last: '2026-09-10' },
    { id: 3, text: `pizza with Björn (id:${TEACHER_B}) on Fridays`, seen: 3, last: '2026-09-10' },
    { id: 4, text: 'café closes at nine', from: `<@${STRANGER}>`, seen: 2 },
  ]);
  assert.deepEqual(Object.keys(view[0]), ['id', 'text', 'from', 'seen', 'last']);
  assert.deepEqual(Object.keys(view[1]), ['id', 'text', 'seen', 'last'], 'from omitted when the item has none');
});

test('buildMemoryRequest: existing_guild learned is [] when nothing, or something that is no list, is stored', () => {
  assert.deepEqual(existingGuildOf(learnedRequest({}, {})).learned, []);
  assert.deepEqual(existingGuildOf(learnedRequest({ learned: 'garbage' }, {})).learned, []);
});

test('applyMemoryUpdate: guild.learned add items are tokenized and stored, the teacher resolved to a token', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, TEACHER_A, 'Aurélie', LEARNED_AT);
    const update = {
      guild: {
        learned: {
          add: [
            { text: 'the kettle is called Ὠκεανός', from: `Aurélie (id:${TEACHER_A})` },
            { text: 'Friday is τυρόπιτα day', from: `<@${TEACHER_B}>` },
            'café closes at nine',
            { text: `pizza with Aurélie (id:${TEACHER_A}) on Fridays`, sure: false },
          ],
        },
      },
    };
    // TEACHER_B has no stored profile but is an author of the batch: known.
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set([TEACHER_B]), { timing: { seenAt: LEARNED_AT } });

    assert.equal(result.learned, 4);
    assert.equal(result.guild, false, 'learned alone does not flip the patterns/starters/injokes flag');
    const learned = store.getGuild(guildId).learned;
    assert.deepEqual(
      learned.map((i) => [i.id, i.text, i.from, i.weight]),
      [
        [1, 'the kettle is called Ὠκεανός', `<@${TEACHER_A}>`, 1],
        [2, 'Friday is τυρόπιτα day', `<@${TEACHER_B}>`, 1],
        [3, 'café closes at nine', undefined, 1],
        [4, `pizza with <@${TEACHER_A}> on Fridays`, undefined, 0],
      ],
    );
    assert.equal(learned[0].firstSeen, new Date(LEARNED_AT).toISOString(), 'dated by the batch, not the wall clock');
    assert.equal(store.getGuild(guildId).learnedNextId, 5);
  });
});

test('applyMemoryUpdate: a learned from is never invented -- an unknown or unparseable teacher is dropped, the item kept', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, TEACHER_A, 'Aurélie', LEARNED_AT);
    const bad = [
      `<@${STRANGER}>`,
      `Zoë (id:${STRANGER})`,
      'Aurélie',
      TEACHER_A,
      `<@${TEACHER_A}> and <@${TEACHER_A}>`,
      `<@${TEACHER_A}> said so`,
      '',
      42,
      { id: TEACHER_A },
      [`<@${TEACHER_A}>`],
      null,
    ];
    const add = bad.map((from, i) => ({ text: `fact ${i}`, from }));
    add.push({ text: `a fact mentioning Aurélie (id:${TEACHER_A})` }); // no from: never derived from the text
    const result = applyMemoryUpdate(store, guildId, { guild: { learned: { add } } }, MEMORY_CFG, new Set());

    assert.equal(result.learned, add.length);
    const learned = store.getGuild(guildId).learned;
    assert.equal(learned.length, add.length);
    for (const item of learned) assert.equal('from' in item, false, `${item.text} must carry no teacher`);
  });
});

test('applyMemoryUpdate: guild.learned seen/remove take integer ids only', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.applyLearnedOps(guildId, { add: ['a fact', 'b fact', 'c fact'] }, { seenAt: LEARNED_AT });
    const update = { guild: { learned: { seen: [1, '3', 1.5, null], remove: ['a fact', 2, '3', -1] } } };
    const result = applyMemoryUpdate(
      store,
      guildId,
      update,
      MEMORY_CFG,
      new Set(),
      { timing: {
      seenAt: LEARNED_AT + 24 * 3_600_000,
    } },
    );

    assert.equal(result.learned, 0, 'no add ops');
    assert.deepEqual(
      store.getGuild(guildId).learned.map((i) => [i.id, i.text, i.weight]),
      [
        [1, 'a fact', 2],
        [3, 'c fact', 1],
      ],
    );
  });
});

test('applyMemoryUpdate: malformed guild.learned never throws and stores nothing', () => {
  withStore((store) => {
    const guildId = 'g1';
    const garbage = [
      null,
      'x',
      42,
      [],
      [{ text: 'an array is not ops' }],
      { add: 'x' },
      { add: [null, 42, {}, [], { text: 42 }, { text: '   ' }, { from: `<@${TEACHER_A}>` }] },
      { seen: '1' },
      { remove: { id: 1 } },
    ];
    for (const learned of garbage) {
      const result = applyMemoryUpdate(store, guildId, { guild: { learned } }, MEMORY_CFG, new Set());
      assert.equal(result.learned, 0, `garbage ${JSON.stringify(learned)}`);
    }
    assert.deepEqual(store.getGuild(guildId).learned, []);
    assert.equal(store.getGuild(guildId).learnedNextId, 1);
  });
});

test('applyMemoryUpdate: learned text is clamped to memory.learnedChars and the caps come from config.memory', () => {
  withStore((store) => {
    const guildId = 'g1';
    const cfg = { ...MEMORY_CFG, learnedChars: 10, clampTolerance: 1, maxLearned: 1, maxLearnedStored: 2 };
    const add = ['ω'.repeat(50), 'second', 'third'];
    applyMemoryUpdate(store, guildId, { guild: { learned: { add } } }, cfg, new Set());
    const learned = store.getGuild(guildId).learned;
    assert.equal(learned.length, 2);
    assert.ok(learned.every((i) => Array.from(i.text).length <= 10));
  });
});

test('run: deferred lines stay in the buffer and lead the next batch; authors, dates and emoji counts come from the consumed lines only', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const base = Date.UTC(2026, 0, 9, 12);
    // Six long lines, one custom emoji each; the last one by a second author.
    for (let i = 0; i < 6; i += 1) {
      store.pushBuffer(
        guildId,
        slimMessage({
          id: `m${i}`,
          authorId: i < 5 ? '1' : '2',
          authorName: i < 5 ? 'Aria' : 'Βράνος',
          content: `γραμμή ${i} ${'word '.repeat(100)}`,
          emojis: [{ id: '777777777777777777', name: 'βάτραχος' }],
          ts: base + i * MINUTE_MS,
        }),
        100,
      );
    }
    const hot = {
      config: makeConfig({
        llm: { ...makeConfig().llm, maxRequestTokens: 600, safetyMargin: 1 },
        memory: { ...makeConfig().memory, batchMessages: 6, minBatchMessages: 1 },
      }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const requests = [];
    // Both authors get an interest: only an author of a consumed line may be written.
    const answer = { users: { 1: { interests: { add: [{ topic: 'κήπος', note: '' }] } }, 2: { interests: { add: [{ topic: 'βροχή', note: '' }] } } } };
    const llm = { complete: async (messages) => { requests.push(messages[1].content); return { text: JSON.stringify(answer) }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => base + HOUR_MS });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));
    const first = logs.find((entry) => entry.msg === 'memory: update applied');
    assert.ok(first.shown >= 1 && first.shown < 6, `the tight cap shows only some of the lines (${first.shown})`);
    assert.equal(first.consumed, first.shown);
    assert.equal(first.emojiUsage, first.shown, 'one emoji per consumed line, none from a deferred one');
    assert.equal(store.getBuffer(guildId)[0].id, `m${first.shown}`, 'the first deferred line leads the buffer');
    assert.equal(first.droppedUsers, 1, 'the second author wrote nothing the model saw');
    assert.equal(store.getUser(guildId, '2') ?? null, null, 'no profile for them yet');
    assert.equal(store.getUser(guildId, '1').interests[0].lastSeen, new Date(base + (first.shown - 1) * MINUTE_MS).toISOString(), 'dated by the newest consumed line');

    hot.config.llm.maxRequestTokens = 50000;
    await withCapturedLogs(() => updater.run(guildId));
    const second = requests[1];
    assert.ok(second.includes(`γραμμή ${first.shown} `), 'the deferred lines lead the next batch');
    assert.ok(!second.includes('γραμμή 0 '), 'a consumed line is never sent again');
    assert.deepEqual(store.getBuffer(guildId), []);
    assert.equal(store.getUser(guildId, '2').interests[0].topic, 'βροχή');
  });
});

// ---- private chat (Discord DMs) -------------------------------------------

function privateHot(memoryOverrides = {}, configOverrides = {}) {
  return {
    config: makeConfig({ memory: { ...makeConfig().memory, ...memoryOverrides }, ...configOverrides }),
    prompts: { memory: 'memory system prompt', labels },
  };
}

function dmMessage(overrides) {
  return slimMessage({ channelId: 'dm1', channelName: 'Zoé', authorId: 'u1', authorName: 'Zoé', ...overrides });
}

/** A public profile for u1 plus a private layer with one detail, one interest and a private score. */
function seedPrivate(store, guildId) {
  store.touchUser(guildId, 'u1', 'Zoé', Date.UTC(2026, 0, 1));
  store.applyProfileOps(guildId, 'u1', { character: 'Public character note.', details: { add: ['public detail'] } }, { fieldChars: 400 });
  store.adjustAffinity(guildId, 'u1', 10, 'public reason', { maxDelta: 15, damping: false });
  store.applyPrivateOps(
    guildId,
    'u1',
    { interests: { add: [{ topic: 'κιθάρα', note: 'plays at night' }] }, details: { add: ['private detail'] } },
    { fieldChars: 400 },
  );
  store.adjustPrivateAffinity(guildId, 'u1', 4, 'private reason', { maxDelta: 15, damping: false });
}

/** The body of one `<tag>` block of a request's user message, or null when absent. */
function blockBody(content, tag) {
  const match = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(content);
  return match ? match[1] : null;
}

test('observe: a private message goes to the private buffer only, never the guild buffer or the public counters', () => {
  withStore((store) => {
    const updater = createMemoryUpdater({ hot: privateHot({ batchMessages: 2 }), store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    for (let i = 1; i <= 8; i += 1) updater.observe('g1', dmMessage({ id: `m${i}`, ts: i }), { direct: true, private: 'u1' });

    assert.deepEqual(store.getBuffer('g1'), []);
    assert.equal(store.getUser('g1', 'u1'), null, 'no public profile is created or touched');
    assert.equal(store.getChannel('g1', 'dm1'), null, 'the DM channel never enters the channel map');
    const buffer = store.getPrivateBuffer('g1', 'u1');
    assert.deepEqual(buffer.map((m) => m.id), ['m3', 'm4', 'm5', 'm6', 'm7', 'm8'], 'capped at batchMessages * 3, like the guild buffer');
    assert.equal(buffer[0].direct, true);
  });
});

test('observe: the persona own DM line is buffered under the partner, not directed; paused -> nothing', () => {
  withStore((store) => {
    const updater = createMemoryUpdater({ hot: privateHot(), store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    updater.observe('g1', dmMessage({ id: 's1', self: true, authorId: 'bot', authorName: 'Nept' }), { private: 'u1' });
    const [line] = store.getPrivateBuffer('g1', 'u1');
    assert.equal(line.self, true);
    assert.equal(line.direct, false);

    store.state.data.paused = true;
    updater.observe('g1', dmMessage({ id: 'm2' }), { direct: true, private: 'u1' });
    assert.equal(store.getPrivateBuffer('g1', 'u1').length, 1);
  });
});

test('analyzePrivate: the request carries <private>, only this user private profile with the effective affinity, <public_profile>, no channels', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    seedPrivate(store, guildId);
    store.touchUser(guildId, 'u2', 'Ander', 1000);
    store.updateGuild(guildId, { patterns: 'guild pattern' });
    let sent = null;
    const llm = {
      complete: async (messages, opts) => {
        sent = { messages, opts };
        return { text: '{}' };
      },
    };
    const hot = privateHot({ maxOutputTokens: 1234, timeoutMs: 777 });
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const outcome = await updater.analyzePrivate(guildId, 'u1', [
      dmMessage({ id: 'm1', content: 'γεια σου', direct: true, ts: Date.UTC(2026, 0, 2, 10) }),
      dmMessage({ id: 'm2', self: true, authorId: 'bot', authorName: 'Nept', content: 'hi', ts: Date.UTC(2026, 0, 2, 10, 1) }),
    ]);
    assert.equal(outcome.ok, true);

    assert.equal(sent.messages[0].content, 'memory system prompt');
    assert.equal(sent.opts.maxOutputTokens, 1234);
    assert.equal(sent.opts.timeoutMs, 777);
    const user = sent.messages[1].content;

    assert.equal(blockBody(user, 'private'), labels.memory.privateNote);

    const profiles = JSON.parse(blockBody(user, 'existing_profiles'));
    assert.deepEqual(Object.keys(profiles), ['u1']);
    const mine = profiles.u1;
    assert.deepEqual(mine.details.map((d) => d.text), ['private detail']);
    assert.equal(mine.details[0].id, 1);
    assert.deepEqual(mine.interests.map((i) => i.topic), ['κιθάρα']);
    assert.equal(mine.affinity.score, 14, 'public 10 + private 4');
    assert.equal(mine.affinity.reason, 'private reason');
    assert.equal(mine.character, undefined, 'the public portrait is not offered for editing');
    assert.equal(mine.style, undefined);
    assert.equal(mine.names, undefined);

    const publicProfile = blockBody(user, 'public_profile');
    assert.ok(publicProfile.includes('Public character note.'));
    assert.ok(publicProfile.includes('public detail'));
    assert.ok(!publicProfile.includes('private detail'));

    assert.ok(JSON.parse(blockBody(user, 'existing_guild')).patterns.includes('guild pattern'));
    assert.equal(blockBody(user, 'existing_channels'), null);
    assert.equal(blockBody(user, 'known_members'), null, 'a private batch carries no alias roster');
    assert.ok(!user.includes('Ander'), 'no other member profile is sent');

    const transcript = blockBody(user, 'new_messages');
    assert.ok(transcript.includes(`## #${labels.memory.privateChannel} (id:dm1)`));
    assert.ok(!transcript.includes('## #Zoé'));
    assert.ok(transcript.includes('γεια σου'));
  });
});

test('analyzePrivate: applies only users[userId] to the private layer and reports every dropped section as counts', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    seedPrivate(store, guildId);
    store.touchUser(guildId, 'u2', 'Ander', 1000);
    store.updateGuild(guildId, { patterns: 'guild pattern' });
    store.flush();
    const publicBefore = JSON.stringify(store.getUser(guildId, 'u1'));
    const otherBefore = JSON.stringify(store.getUser(guildId, 'u2'));
    const answer = {
      users: {
        u1: {
          relationship: 'private relationship note',
          character: 'rewritten character',
          style: 'rewritten style',
          portrait: 'refresh please',
          aliases: { add: ['Zo'] },
          interests: { add: [{ topic: 'θάλασσα', note: 'swims' }] },
          details: { add: ['second private detail'] },
          affinity: { delta: 50, reason: 'was kind' },
          episodes: [{ what: 'shared a secret', weight: 3 }],
        },
        u2: { relationship: 'must not land' },
        u3: { relationship: 'must not land either' },
      },
      guild: { patterns: 'must not land' },
      channels: { dm1: { purpose: 'must not land' } },
      lore: [{ title: 'secret', keys: ['secret'], text: 'must not land' }],
      self: ['must not land'],
    };
    const llm = { complete: async () => ({ text: JSON.stringify(answer) }) };
    const portraits = [];
    const updater = createMemoryUpdater({
      hot: privateHot({}, { relationships: { damping: false } }),
      store,
      llm,
      calibrator: createCalibrator(),
      getSelfName: () => 'Nept',
      now: () => Date.UTC(2026, 0, 3),
      onPortraitRequest: (...args) => portraits.push(args),
    });

    const outcome = await updater.analyzePrivate(guildId, 'u1', [dmMessage({ id: 'm1', direct: true, ts: Date.UTC(2026, 0, 2) })]);
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.result.dropped, { users: 2, guild: true, channels: 1, lore: 1, self: 1, portrait: 2, recent: 0 });
    assert.equal(outcome.result.users, 1);

    const priv = store.getPrivate(guildId, 'u1');
    assert.equal(priv.relationship, 'private relationship note');
    assert.deepEqual(priv.interests.map((i) => i.topic).sort(), ['θάλασσα', 'κιθάρα'].sort());
    assert.deepEqual(priv.details.map((d) => d.text), ['private detail', 'second private detail']);
    assert.equal(priv.affinity.score, 4 + 15, 'the delta is clamped to maxDeltaPerUpdate (15 by default), undamped here');
    assert.equal(priv.affinity.reason, 'was kind');
    assert.equal(priv.episodes.length, 1);
    assert.equal(priv.episodes[0].what, 'shared a secret');
    assert.equal(priv.character, undefined);
    assert.equal(priv.aliases, undefined);
    assert.equal(priv.lastSeen, new Date(Date.UTC(2026, 0, 3)).toISOString());
    assert.equal(priv.firstSeen, new Date(Date.UTC(2026, 0, 3)).toISOString());

    assert.equal(JSON.stringify(store.getUser(guildId, 'u1')), publicBefore, 'the public profile is never changed by a DM');
    assert.equal(JSON.stringify(store.getUser(guildId, 'u2')), otherBefore);
    assert.equal(store.getPrivate(guildId, 'u2'), null);
    assert.equal(store.getUser(guildId, 'u3'), null);
    assert.equal(store.getGuild(guildId).patterns, 'guild pattern');
    assert.deepEqual(store.getGuild(guildId).self ?? [], []);
    assert.equal(store.getChannel(guildId, 'dm1'), null);
    assert.deepEqual(store.getLore(guildId), []);
    assert.deepEqual(portraits, [], 'a portrait cue from a DM is ignored');
  });
});

test('analyzePrivate: firstSeen is kept once set, lastSeen moves', async () => {
  await withStoreAsync(async (store) => {
    let nowValue = Date.UTC(2026, 0, 3);
    const updater = createMemoryUpdater({
      hot: privateHot(),
      store,
      llm: { complete: async () => ({ text: '{}' }) },
      calibrator: createCalibrator(),
      getSelfName: () => 'Nept',
      now: () => nowValue,
    });
    await updater.analyzePrivate('g1', 'u1', [dmMessage({ id: 'm1' })]);
    nowValue = Date.UTC(2026, 0, 9);
    await updater.analyzePrivate('g1', 'u1', [dmMessage({ id: 'm2' })]);
    const priv = store.getPrivate('g1', 'u1');
    assert.equal(priv.firstSeen, new Date(Date.UTC(2026, 0, 3)).toISOString());
    assert.equal(priv.lastSeen, new Date(Date.UTC(2026, 0, 9)).toISOString());
  });
});

test('analyzePrivate: relationships and episodes switched off -> affinity and episodes are ignored', async () => {
  await withStoreAsync(async (store) => {
    const answer = { users: { u1: { affinity: { delta: 5, reason: 'x' }, episodes: [{ what: 'moment', weight: 2 }] } } };
    const updater = createMemoryUpdater({
      hot: privateHot({}, { features: { relationships: false, episodes: false } }),
      store,
      llm: { complete: async () => ({ text: JSON.stringify(answer) }) },
      calibrator: createCalibrator(),
      getSelfName: () => 'Nept',
    });
    const outcome = await updater.analyzePrivate('g1', 'u1', [dmMessage({ id: 'm1' })]);
    assert.equal(outcome.ok, true);
    const priv = store.getPrivate('g1', 'u1');
    assert.equal(priv.affinity.score, 0);
    assert.deepEqual(priv.episodes, []);
  });
});

test('tick: a due private buffer is analyzed, shifted after success and logged with counts only', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '99999', 'Ander', 1000);
    const llmCalls = [];
    const answer = { users: { u1: { relationship: 'note' }, 99999: { relationship: 'x' } }, self: ['x'] };
    const llm = {
      complete: async (messages) => {
        llmCalls.push(messages);
        return { text: JSON.stringify(answer) };
      },
    };
    const hot = privateHot({ batchMessages: 3, minBatchMessages: 2 });
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const base = Date.now();
    for (let i = 0; i < 2; i += 1) updater.observe(guildId, dmMessage({ id: `a${i}`, ts: base + i }), { private: 'u1' });
    await updater.tick();
    assert.equal(llmCalls.length, 0, 'not due yet: below batchMessages and still fresh');

    for (let i = 2; i < 7; i += 1) updater.observe(guildId, dmMessage({ id: `a${i}`, ts: base + i }), { private: 'u1' });
    const { logs } = await withCapturedLogs(() => updater.tick());
    assert.equal(llmCalls.length, 1);
    assert.deepEqual(store.getPrivateBuffer(guildId, 'u1').map((m) => m.id), ['a6'], 'batchMessages * 2 consumed, the rest kept');
    assert.deepEqual(store.getBuffer(guildId), []);
    assert.equal(store.getPrivate(guildId, 'u1').relationship, 'note');

    assert.ok(logs.some((entry) => entry.msg === 'memory: private update applied'), 'the update was applied');
    const text = JSON.stringify(logs);
    assert.ok(!text.includes('99999'), 'never another member id');
    assert.ok(!text.includes('"u1"'), 'not even the partner id');
  });
});

test('tick: a private buffer of 5 member lines and 5 replies is analyzed once its oldest line is memory.privateMaxAgeMinutes old; the guild buffer keeps its own rule', async () => {
  await withStoreAsync(async (store) => {
    const base = Date.UTC(2026, 0, 5, 8);
    let nowValue = base + 359 * MINUTE_MS;
    const calls = [];
    const llm = { complete: async (messages) => { calls.push(messages); return { text: '{}' }; } };
    // Below minBatchMessages (15) and directTriggerCount (6); only the age path (360 minutes) can make it due.
    const hot = privateHot({ privateMaxAgeMinutes: 360 }, { relationships: { directTriggerCount: 6 } });
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowValue });
    for (let i = 0; i < 5; i += 1) {
      updater.observe('g1', dmMessage({ id: `u${i}`, ts: base + 2 * i * MINUTE_MS }), { direct: true, private: 'u1' });
      updater.observe('g1', dmMessage({ id: `s${i}`, self: true, authorId: 'bot', authorName: 'Nept', ts: base + (2 * i + 1) * MINUTE_MS }), { private: 'u1' });
      updater.observe('g1', slimMessage({ id: `g${i}`, ts: base + i * MINUTE_MS }));
    }

    await withCapturedLogs(() => updater.tick());
    assert.equal(calls.length, 0, '359 minutes: not yet');

    nowValue = base + 361 * MINUTE_MS;
    await withCapturedLogs(() => updater.tick());
    assert.equal(calls.length, 1, 'the private buffer, once');
    assert.deepEqual(store.getPrivateBuffer('g1', 'u1'), []);
    assert.equal(store.getBuffer('g1').length, 5, 'the guild path passes no age: its 5 lines wait');
  });
});

test('tick: memory.privateMaxAgeMinutes is read at each tick, and 0 turns the private age path off', async () => {
  await withStoreAsync(async (store) => {
    const base = Date.UTC(2026, 0, 5, 8);
    const calls = [];
    const llm = { complete: async (messages) => { calls.push(messages); return { text: '{}' }; } };
    const hot = privateHot({ privateMaxAgeMinutes: 0 });
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => base + 500 * MINUTE_MS });
    updater.observe('g1', dmMessage({ id: 'u0', ts: base }), { direct: true, private: 'u1' });

    await withCapturedLogs(() => updater.tick());
    assert.equal(calls.length, 0, '0 = off');
    hot.config.memory.privateMaxAgeMinutes = 600;
    await withCapturedLogs(() => updater.tick());
    assert.equal(calls.length, 0, '500 minutes is not 600');
    hot.config.memory.privateMaxAgeMinutes = 480;
    await withCapturedLogs(() => updater.tick());
    assert.equal(calls.length, 1);
  });
});

test('runPrivate: the "memory: private update applied" log says how many lines the model saw and how many were deferred', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = privateHot({ batchMessages: 6, minBatchMessages: 1 }, { llm: { ...makeConfig().llm, maxRequestTokens: 900, safetyMargin: 1 } });
    const updater = createMemoryUpdater({ hot, store, llm: { complete: async () => ({ text: '{}' }) }, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    const base = Date.now() - 60_000;
    for (let i = 0; i < 6; i += 1) {
      updater.observe(guildId, dmMessage({ id: `a${i}`, content: `line ${i} ${'word '.repeat(100)}`, ts: base + i * 1000 }), { private: 'u1' });
    }

    const { logs } = await withCapturedLogs(() => updater.runPrivate(guildId, 'u1'));

    const applied = logs.find((entry) => entry.msg === 'memory: private update applied');
    assert.ok(applied, 'the update was applied');
    assert.equal(applied.consumed, applied.shown, 'nothing consumed unseen');
    assert.ok(Number.isInteger(applied.shown) && applied.shown > 0, 'some oldest lines fit');
    assert.ok(Number.isInteger(applied.deferred) && applied.deferred > 0, 'the newest lines did not');
    assert.equal(applied.shown + applied.deferred, 6);
    assert.deepEqual(
      store.getPrivateBuffer(guildId, 'u1').map((m) => m.id),
      Array.from({ length: applied.deferred }, (_, i) => `a${6 - applied.deferred + i}`),
      'only the lines shown are consumed; the deferred newest ones stay in the buffer',
    );
  });
});

test('observe: a private buffer over its cap logs "memory: private buffer trimmed" with the count, never the member', async () => {
  await withStoreAsync(async (store) => {
    const updater = createMemoryUpdater({ hot: privateHot({ batchMessages: 1 }), store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const { logs } = await withCapturedLogs(() => {
      for (let i = 1; i <= 4; i += 1) updater.observe('g1', dmMessage({ id: `m${i}`, content: `κείμενο ${i}`, ts: i }), { private: 'u1' });
    });

    const trimmed = logs.filter((entry) => entry.msg === 'memory: private buffer trimmed');
    assert.equal(trimmed.length, 1, 'only the push past the cap (batchMessages * 3) logs');
    assert.equal(trimmed[0].dropped, 1);
    const text = JSON.stringify(logs);
    assert.ok(!text.includes('u1'), 'never the partner id');
    assert.ok(!text.includes('κείμενο'), 'never message contents');
  });
});

test('tick: a failed private update keeps the buffer, logs a warning and backs off', async () => {
  await withStoreAsync(async (store) => {
    let calls = 0;
    const llm = {
      complete: async () => {
        calls += 1;
        throw new Error('boom');
      },
    };
    let nowValue = Date.now();
    const updater = createMemoryUpdater({
      hot: privateHot({ batchMessages: 2, minBatchMessages: 1 }),
      store,
      llm,
      calibrator: createCalibrator(),
      getSelfName: () => 'Nept',
      now: () => nowValue,
    });
    for (let i = 0; i < 2; i += 1) updater.observe('g1', dmMessage({ id: `m${i}`, ts: nowValue + i }), { private: 'u1' });

    const { logs } = await withCapturedLogs(() => updater.tick());
    assert.equal(calls, 1);
    assert.equal(store.getPrivateBuffer('g1', 'u1').length, 2, 'the buffer is kept');
    assert.ok(logs.some((entry) => entry.level === 'warn' && entry.msg.startsWith('memory: private update failed')));
    assert.equal(store.getPrivate('g1', 'u1').lastSeen, '', 'nothing stamped on a failure');

    await updater.tick();
    assert.equal(calls, 1, 'backed off');
    nowValue += 16 * 60_000;
    await updater.tick();
    assert.equal(calls, 2, 'retried after the back-off');
  });
});

test('tick: a truncated private batch above the floor is retried smaller at the next tick; at the floor it backs off and is sent again after', async () => {
  await withStoreAsync(async (store) => {
    let nowValue = 1_000_000_000;
    const sent = [];
    const llm = {
      complete: async (llmMessages) => {
        sent.push(linesSent(llmMessages));
        return TRUNCATED;
      },
    };
    // batchMessages 15: a normal batch takes 30, the first halving reaches the floor (20).
    const updater = createMemoryUpdater({
      hot: privateHot({ batchMessages: 15, minBatchMessages: 1 }),
      store,
      llm,
      calibrator: createCalibrator(),
      getSelfName: () => 'Nept',
      now: () => nowValue,
    });
    for (let i = 0; i < 40; i += 1) updater.observe('g1', dmMessage({ id: `m${i}`, content: `line-${i}-end`, ts: nowValue + i }), { private: 'u1' });

    const first = await withCapturedLogs(() => updater.tick());
    assert.deepEqual(sent, [30]);
    assert.ok(first.logs.some((entry) => entry.msg === 'memory: private update failed, halving the batch size for next time'));

    const second = await withCapturedLogs(() => updater.tick());
    assert.deepEqual(sent, [30, 20], 'retried smaller at the very next tick');
    const backedOff = second.logs.find((entry) => entry.msg === 'memory: private update failed, backing off');
    assert.ok(backedOff, 'at the floor: backed off');
    assert.equal(backedOff.reason, 'truncated');
    assert.equal(backedOff.atFloor, true);
    assert.equal(backedOff.backoffMs, 15 * MINUTE_MS);
    assert.ok(!JSON.stringify(second.logs).includes('u1'), 'never the partner id');

    await updater.tick();
    nowValue += 15 * MINUTE_MS - 1;
    await updater.tick();
    assert.deepEqual(sent, [30, 20], 'not sent again before the back-off ends');

    nowValue += 1;
    await updater.tick();
    assert.deepEqual(sent, [30, 20, 20], 'sent again once the back-off is over');
    assert.equal(store.getPrivateBuffer('g1', 'u1').length, 40, 'the stored buffer is never dropped');
  });
});

test('tick: never runs the same private buffer twice at once; waitIdle waits for a private run', async () => {
  await withStoreAsync(async (store) => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const llm = {
      complete: async () => {
        calls += 1;
        await gate;
        return { text: '{}' };
      },
    };
    const updater = createMemoryUpdater({
      hot: privateHot({ batchMessages: 2, minBatchMessages: 1 }),
      store,
      llm,
      calibrator: createCalibrator(),
      getSelfName: () => 'Nept',
    });
    for (let i = 0; i < 2; i += 1) updater.observe('g1', dmMessage({ id: `m${i}`, ts: Date.now() + i }), { private: 'u1' });

    const first = updater.tick();
    await new Promise((resolve) => setImmediate(resolve));
    await updater.tick();
    assert.equal(calls, 1, 'the second tick skips a buffer that is already being analyzed');

    let idle = false;
    const waiting = updater.waitIdle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(idle, false);
    release();
    await first;
    await waiting;
    assert.equal(idle, true);
    assert.equal(store.getPrivateBuffer('g1', 'u1').length, 0);
  });
});

test('analyze: the analyzer request is routed as the extractor role, on its model', async () => {
  await withStoreAsync(async (store) => {
    const hot = { config: makeConfig(), prompts: { memory: 'Summarize.', labels } };
    let seenOptions = null;
    const llm = { complete: async (messages, options) => { seenOptions = options; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    await updater.analyze('g1', [slimMessage({ id: 'm1' })]);

    assert.equal(seenOptions.role, 'extractor');
    assert.equal(seenOptions.model, hot.config.models.base.extractor);
  });
});

// ---- relationship text vs affinity band (relationshipScore / relationshipStale) ----

/** The relationship-text triggers pinned, so these tests state what they rely on. */
const RELATIONSHIP_STALE_PIN = { rewriteOnBandChange: true, bandHysteresis: 2, rewriteOnDrift: 8, rewriteAfterMoves: 6 };

function profilesViewOf(profile, configOverrides = {}, privateChat) {
  const config = makeConfig({
    features: { relationships: true },
    ...configOverrides,
    relationships: { ...RELATIONSHIP_STALE_PIN, ...configOverrides.relationships },
  });
  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator: createCalibrator(),
    profiles: { 1: { names: ['nick'], character: '', interests: [], style: '', details: [], ...profile } },
    guildMemory: {},
    messages: [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })],
    selfName: 'Nept',
    privateChat,
  });
  return JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(llmMessages[1].content)[1])['1'];
}

test('buildMemoryRequest: relationshipStale when the band moved since the relationship text was written', () => {
  const view = profilesViewOf({ relationship: 'Barely knows them', relationshipScore: 26, affinity: { score: 64, reason: 'r', history: [] } });
  assert.deepEqual(view.relationshipStale, { writtenAt: 'fond', now: 'devoted', cause: 'band' });
  assert.equal(view.affinity.band, 'devoted');
});

test('buildMemoryRequest: a missing relationshipScore counts as 0 (neutral)', () => {
  const view = profilesViewOf({ relationship: 'Barely knows them', affinity: { score: 30, reason: '', history: [] } });
  assert.deepEqual(view.relationshipStale, { writtenAt: 'neutral', now: 'fond', cause: 'band' });
});

// Drift and moves off: the band rule alone, as it stood before those two triggers existed.
test('buildMemoryRequest: no relationshipStale within the same band, with an empty text, or with the switch off', () => {
  const bandOnly = { rewriteOnDrift: 0, rewriteAfterMoves: 0 };
  const sameBand = profilesViewOf({ relationship: 'Friends', relationshipScore: 26, affinity: { score: 59, reason: '', history: [] } }, { relationships: bandOnly });
  assert.equal(sameBand.relationshipStale, undefined);

  const off = profilesViewOf(
    { relationship: 'Friends', relationshipScore: 0, affinity: { score: 80, reason: '', history: [] } },
    { relationships: { rewriteOnBandChange: false, ...bandOnly } },
  );
  assert.equal(off.relationshipStale, undefined);
  assert.equal(off.affinity.band, 'devoted', 'the band itself is still shown');
});

test('buildMemoryRequest: an empty relationship with episodes gets relationshipStale writtenAt "none"', () => {
  const view = profilesViewOf({
    relationship: '',
    affinity: { score: 0, reason: '', history: [] },
    episodes: [{ date: '2026-01-01', what: 'shared a joke', weight: 2 }],
  });
  assert.deepEqual(view.relationshipStale, { writtenAt: 'none', now: 'neutral', cause: 'first' });
});

test('buildMemoryRequest: an empty relationship with a non-zero score or a reason gets writtenAt "none"', () => {
  const scored = profilesViewOf({ relationship: '', affinity: { score: 30, reason: '', history: [] } });
  assert.deepEqual(scored.relationshipStale, { writtenAt: 'none', now: 'fond', cause: 'first' });
  const reasoned = profilesViewOf({ relationship: '  ', affinity: { score: 0, reason: 'was kind once', history: [] } });
  assert.deepEqual(reasoned.relationshipStale, { writtenAt: 'none', now: 'neutral', cause: 'first' });
});

test('buildMemoryRequest: an empty relationship with score 0, no reason and no episodes gets no marker', () => {
  const view = profilesViewOf({ relationship: '', affinity: { score: 0, reason: '', history: [] }, episodes: [] });
  assert.equal(view.relationshipStale, undefined);
  const noAffinity = profilesViewOf({ relationship: '' });
  assert.equal(noAffinity.relationshipStale, undefined);
});

test('buildMemoryRequest: switch off -> no "none" marker for an empty relationship either', () => {
  const view = profilesViewOf(
    { relationship: '', affinity: { score: 40, reason: 'r', history: [] }, episodes: [{ date: '2026-01-01', what: 'x', weight: 1 }] },
    { relationships: { rewriteOnBandChange: false } },
  );
  assert.equal(view.relationshipStale, undefined);
});

test('analyzePrivate: an empty private relationship with a non-zero effective score gets writtenAt "none"', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    seedPrivate(store, guildId); // effective 14 -> warm, private relationship empty
    let sent = null;
    const llm = { complete: async (messages) => ((sent = messages), { text: '{}' }) };
    const updater = createMemoryUpdater({ hot: privateHot({}, { relationships: RELATIONSHIP_STALE_PIN }), store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    await updater.analyzePrivate(guildId, 'u1', [dmMessage({ id: 'm1', direct: true, ts: Date.UTC(2026, 0, 2, 10) })]);

    const mine = JSON.parse(blockBody(sent[1].content, 'existing_profiles')).u1;
    assert.deepEqual(mine.relationshipStale, { writtenAt: 'none', now: 'warm', cause: 'first' });
  });
});

test('buildMemoryRequest: features.relationships off -> neither band nor relationshipStale', () => {
  const view = profilesViewOf(
    { relationship: 'Friends', relationshipScore: 0, affinity: { score: 80, reason: '', history: [] } },
    { features: { relationships: false } },
  );
  assert.equal(view.affinity, undefined);
  assert.equal(view.relationshipStale, undefined);
});

test('applyMemoryUpdate: a written relationship stamps relationshipScore with the score after this batch delta', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.adjustAffinity(guildId, '1', 20, 'start', { maxDelta: Infinity, historySize: 10, now: Date.now() });

    const update = { users: { 1: { relationship: 'Getting closer', affinity: { delta: 10, reason: 'kind' } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { relationships: RELATIONSHIPS_CFG });

    const profile = store.getUser(guildId, '1');
    // damped: 20 + 10 * (1 - 20/100) = 28
    assert.equal(profile.affinity.score, 28);
    assert.equal(profile.relationshipScore, 28);
  });
});

test('applyMemoryUpdate: no relationship text -> relationshipScore untouched, even when the score moves', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.applyProfileOps(guildId, '1', { relationship: 'Strangers' }, { fieldChars: 400 });
    assert.equal(store.getUser(guildId, '1').relationshipScore, 0);

    const update = { users: { 1: { relationship: '', affinity: { delta: 10, reason: 'kind' } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), { relationships: RELATIONSHIPS_CFG });

    const profile = store.getUser(guildId, '1');
    assert.equal(profile.affinity.score, 10);
    assert.equal(profile.relationshipScore, 0);
    assert.equal(profile.relationship, 'Strangers');
  });
});

test('applyMemoryUpdate: relationships disabled still stamps the current score with a written text', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.adjustAffinity(guildId, '1', 40, 'start', { maxDelta: Infinity, historySize: 10, now: Date.now() });
    const update = { users: { 1: { relationship: 'Friends', affinity: { delta: 10, reason: 'kind' } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']));
    assert.equal(store.getUser(guildId, '1').affinity.score, 40);
    assert.equal(store.getUser(guildId, '1').relationshipScore, 40);
  });
});

test('applyPrivateUpdate: a written private relationship stamps the EFFECTIVE score after this batch delta', () => {
  withStore((store) => {
    const guildId = 'g1';
    seedPrivate(store, guildId); // public 10, private 4
    const update = { users: { u1: { relationship: 'Trusts the persona', affinity: { delta: 6, reason: 'kind' } } } };
    applyPrivateUpdate(store, guildId, 'u1', update, MEMORY_CFG, { relationships: { ...RELATIONSHIPS_CFG, damping: false } });

    const priv = store.getPrivate(guildId, 'u1');
    assert.equal(priv.affinity.score, 10);
    assert.equal(priv.relationshipScore, 20, 'public 10 + private 10, what the private analyzer sees');
    assert.equal(store.getUser(guildId, 'u1').relationshipScore, undefined, 'the public profile is untouched');
  });
});

test('applyPrivateUpdate: no private relationship text -> no relationshipScore', () => {
  withStore((store) => {
    const guildId = 'g1';
    seedPrivate(store, guildId);
    applyPrivateUpdate(store, guildId, 'u1', { users: { u1: { affinity: { delta: 6, reason: 'kind' } } } }, MEMORY_CFG, { relationships: RELATIONSHIPS_CFG });
    assert.equal(store.getPrivate(guildId, 'u1').relationshipScore, undefined);
  });
});

test('analyzePrivate: the view compares the effective band with the private relationshipScore', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    seedPrivate(store, guildId); // effective 14 -> warm
    store.applyPrivateOps(guildId, 'u1', { relationship: 'A private note' }, { fieldChars: 400, relationshipScore: 0 });
    let sent = null;
    const llm = { complete: async (messages) => ((sent = messages), { text: '{}' }) };
    const updater = createMemoryUpdater({ hot: privateHot({}, { relationships: RELATIONSHIP_STALE_PIN }), store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    await updater.analyzePrivate(guildId, 'u1', [dmMessage({ id: 'm1', direct: true, ts: Date.UTC(2026, 0, 2, 10) })]);

    const mine = JSON.parse(blockBody(sent[1].content, 'existing_profiles')).u1;
    assert.equal(mine.affinity.band, 'warm');
    assert.deepEqual(mine.relationshipStale, { writtenAt: 'neutral', now: 'warm', cause: 'band' });
  });
});

// ---- relationship drift, moves and the length limit (relationshipWrittenAt, relationshipChars) ----

const TEXT_WRITTEN_MS = Date.UTC(2026, 9, 1, 12, 0, 0);

/** `count` attitude moves stamped one hour apart, starting one hour after TEXT_WRITTEN_MS. */
function movesAfterText(count) {
  return Array.from({ length: count }, (_, i) => ({
    ts: new Date(TEXT_WRITTEN_MS + (i + 1) * 3600_000).toISOString(),
    delta: 1,
    appliedDelta: 1,
    score: 30,
    reason: 'μια κουβέντα',
  }));
}

test('buildMemoryRequest: relationshipStale carries cause next to writtenAt and now', () => {
  const written = { relationship: 'Φίλοι.', relationshipScore: 26, relationshipWrittenAt: new Date(TEXT_WRITTEN_MS).toISOString() };
  const drift = profilesViewOf({ ...written, affinity: { score: 34, reason: '', history: [] } });
  assert.deepEqual(drift.relationshipStale, { writtenAt: 'fond', now: 'fond', cause: 'drift' });

  const moves = profilesViewOf({ ...written, relationshipScore: 30, affinity: { score: 30, reason: '', history: movesAfterText(6) } });
  assert.deepEqual(moves.relationshipStale, { writtenAt: 'fond', now: 'fond', cause: 'moves' });
  assert.deepEqual(Object.keys(moves.relationshipStale), ['writtenAt', 'now', 'cause']);

  const edge = profilesViewOf({ ...written, relationshipScore: 59, affinity: { score: 61, reason: '', history: [] } });
  assert.equal(edge.relationshipStale, undefined, 'one point past the edge is inside bandHysteresis (2)');
});

test('buildMemoryRequest: a drift across an edge inside bandHysteresis names in now the band affinity.band shows', () => {
  const view = profilesViewOf({
    relationship: 'Φίλοι.',
    relationshipScore: 53,
    relationshipWrittenAt: new Date(TEXT_WRITTEN_MS).toISOString(),
    affinity: { score: 61, reason: '', history: [] },
  });
  assert.deepEqual(view.relationshipStale, { writtenAt: 'fond', now: 'devoted', cause: 'drift' });
  assert.equal(view.relationshipStale.now, view.affinity.band);
});

test('buildMemoryRequest: the relationships.* settings reach the marker from the live config', () => {
  const written = { relationship: 'Φίλοι.', relationshipScore: 59, relationshipWrittenAt: new Date(TEXT_WRITTEN_MS).toISOString() };
  const edge = profilesViewOf({ ...written, affinity: { score: 61, reason: '', history: movesAfterText(2) } }, { relationships: { bandHysteresis: 0 } });
  assert.equal(edge.relationshipStale.cause, 'band');
  const drift = profilesViewOf({ ...written, affinity: { score: 56, reason: '', history: [] } }, { relationships: { rewriteOnDrift: 3 } });
  assert.equal(drift.relationshipStale.cause, 'drift');
  const moves = profilesViewOf({ ...written, affinity: { score: 59, reason: '', history: movesAfterText(2) } }, { relationships: { rewriteAfterMoves: 2 } });
  assert.equal(moves.relationshipStale.cause, 'moves');
});

test('buildMemoryRequest: an unstamped relationship text counts every stored move', () => {
  const view = profilesViewOf({ relationship: 'Φίλοι.', relationshipScore: 30, affinity: { score: 30, reason: '', history: movesAfterText(6) } });
  assert.equal(view.relationshipStale.cause, 'moves');
});

test('buildMemoryRequest: {{relationshipChars}} is the limit voiceLimits gives stage B, whatever relationships.textChars holds', () => {
  const systemOf = (config) =>
    buildMemoryRequest({
      prompts: { memory: '{{relationshipChars}}', labels },
      config,
      calibrator: createCalibrator(),
      profiles: {},
      guildMemory: {},
      messages: [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })],
      selfName: 'Nept',
    }).messages[0].content;
  for (const textChars of [450, 12.5, undefined, null, 'many', 0, -5, NaN, Infinity]) {
    const config = makeConfig({ relationships: { textChars } });
    assert.equal(systemOf(config), String(voiceLimits(config).relationship), `textChars ${String(textChars)}`);
  }
});

// Three sentences of about 40 characters each: a limit of 50 (x 1.25 = 62) keeps the first sentence only.
const LONG_RELATIONSHIP = 'Μιλάμε συχνά για βιβλία και για ταξίδια. Μου λέει πάντα την αλήθεια χωρίς φόβο. Γελάμε με τα ίδια αστεία κάθε βράδυ μαζί.';
const FIRST_SENTENCE = 'Μιλάμε συχνά για βιβλία και για ταξίδια.';

test('applyMemoryUpdate: a written relationship is stamped relationshipWrittenAt on the batch clock and clamped to relationships.textChars', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    const relationships = { ...RELATIONSHIPS_CFG, textChars: 50 };
    applyMemoryUpdate(store, guildId, { users: { 1: { relationship: LONG_RELATIONSHIP, affinity: { delta: 4, reason: 'kind' } } } }, MEMORY_CFG, new Set(['1']), { relationships });

    const profile = store.getUser(guildId, '1');
    assert.equal(profile.relationship, FIRST_SENTENCE);
    assert.equal(profile.relationshipWrittenAt, new Date(RELATIONSHIPS_CFG.now).toISOString());
    assert.equal(profile.affinity.history.at(-1).ts, profile.relationshipWrittenAt, 'the same clock as the batch move');
    assert.equal(profile.relationshipScore, 4);
  });
});

test('applyMemoryUpdate: the relationshipChars option wins; with neither option the text is not cut at fieldChars', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    const longer = `${'Μιλάμε συχνά για βιβλία και για ταξίδια. '.repeat(20)}`.trim();
    applyMemoryUpdate(store, guildId, { users: { 1: { relationship: longer } } }, MEMORY_CFG, new Set(['1']), { relationshipChars: 50, relationships: { ...RELATIONSHIPS_CFG, textChars: 1000 } });
    assert.equal(store.getUser(guildId, '1').relationship, FIRST_SENTENCE);

    // Neither a relationshipChars nor a relationships option (a caller passing no limit at all):
    // the relationship limit of its own (600), not fieldChars. A rewrite of about 530 characters,
    // over fieldChars * 1.25 and within 600, is taken whole. The configured limit with
    // features.relationships off is the analyze()/analyzePrivate() tests below.
    const within = `${'Μιλάμε συχνά για βιβλία και για ταξίδια. '.repeat(13)}`.trim();
    applyMemoryUpdate(store, guildId, { users: { 1: { relationship: within } } }, MEMORY_CFG, new Set(['1']));
    const stored = store.getUser(guildId, '1').relationship;
    assert.ok([...stored].length > MEMORY_CFG.fieldChars * 1.25, 'not clamped at fieldChars');
    assert.equal(stored, within);
    applyMemoryUpdate(store, guildId, { users: { 1: { relationship: longer } } }, MEMORY_CFG, new Set(['1']));
    assert.equal(store.getUser(guildId, '1').relationship, within, 'a rewrite over 600 is refused');
  });
});

test('applyMemoryUpdate: the batch that writes the text does not count its own move toward rewriteAfterMoves', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    applyMemoryUpdate(store, guildId, { users: { 1: { relationship: 'Φίλοι.', affinity: { delta: 3, reason: 'kind' } } } }, MEMORY_CFG, new Set(['1']), { relationships: RELATIONSHIPS_CFG });
    const view = profilesViewOf(store.getUser(guildId, '1'), { relationships: { rewriteAfterMoves: 1 } });
    assert.equal(view.relationshipStale, undefined);

    applyMemoryUpdate(store, guildId, { users: { 1: { affinity: { delta: 2, reason: 'again' } } } }, MEMORY_CFG, new Set(['1']), {
      relationships: { ...RELATIONSHIPS_CFG, now: RELATIONSHIPS_CFG.now + 60_000 },
    });
    const later = profilesViewOf(store.getUser(guildId, '1'), { relationships: { rewriteAfterMoves: 1 } });
    assert.equal(later.relationshipStale.cause, 'moves', 'a later move counts');
  });
});

test('applyPrivateUpdate: a written private relationship is stamped relationshipWrittenAt and clamped to relationships.textChars', () => {
  withStore((store) => {
    const guildId = 'g1';
    seedPrivate(store, guildId);
    const relationships = { ...RELATIONSHIPS_CFG, textChars: 50 };
    applyPrivateUpdate(store, guildId, 'u1', { users: { u1: { relationship: LONG_RELATIONSHIP } } }, MEMORY_CFG, { relationships });

    const priv = store.getPrivate(guildId, 'u1');
    assert.equal(priv.relationship, FIRST_SENTENCE);
    assert.equal(priv.relationshipWrittenAt, new Date(RELATIONSHIPS_CFG.now).toISOString());
    assert.equal(store.getUser(guildId, 'u1').relationshipWrittenAt, undefined, 'the public profile is untouched');
  });
});

test('applyPrivateUpdate: the relationshipChars option wins over relationships.textChars; with neither the text is not cut at fieldChars', () => {
  withStore((store) => {
    const guildId = 'g1';
    seedPrivate(store, guildId);
    applyPrivateUpdate(store, guildId, 'u1', { users: { u1: { relationship: LONG_RELATIONSHIP } } }, MEMORY_CFG, {
      relationshipChars: 50,
      relationships: { ...RELATIONSHIPS_CFG, textChars: 1000 },
    });
    assert.equal(store.getPrivate(guildId, 'u1').relationship, FIRST_SENTENCE);

    // A rewrite of about 530 characters, over fieldChars * 1.25 and within the relationship limit
    // of its own (600), is taken whole; one of about 820 is refused (the store never cuts a rewrite).
    const within = `${'Μιλάμε συχνά για βιβλία και για ταξίδια. '.repeat(13)}`.trim();
    const longer = `${'Μιλάμε συχνά για βιβλία και για ταξίδια. '.repeat(20)}`.trim();
    applyPrivateUpdate(store, guildId, 'u1', { users: { u1: { relationship: within } } }, MEMORY_CFG);
    const stored = store.getPrivate(guildId, 'u1').relationship;
    assert.ok([...stored].length > MEMORY_CFG.fieldChars * 1.25, 'not clamped at fieldChars');
    assert.equal(stored, within);
    const refused = applyPrivateUpdate(store, guildId, 'u1', { users: { u1: { relationship: longer } } }, MEMORY_CFG);
    assert.equal(store.getPrivate(guildId, 'u1').relationship, within);
    assert.equal(refused.overLimit, 1);
    assert.deepEqual(refused.overLimitFields, ['private.relationship']);
  });
});

test('analyze: with features.relationships off a written relationship is still clamped to relationships.textChars', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    const hot = { config: makeConfig({ features: { relationships: false }, relationships: { textChars: 50 } }), prompts: { memory: 'sys', labels } };
    const llm = { complete: async () => ({ text: JSON.stringify({ users: { 1: { relationship: LONG_RELATIONSHIP } } }) }) };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1' })]);
    assert.equal(outcome.ok, true);
    assert.equal(store.getUser(guildId, '1').relationship, FIRST_SENTENCE);
  });
});

test('analyzePrivate: with features.relationships off a written private relationship is still clamped to relationships.textChars', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    seedPrivate(store, guildId);
    const hot = privateHot({}, { features: { relationships: false }, relationships: { textChars: 50 } });
    const llm = { complete: async () => ({ text: JSON.stringify({ users: { u1: { relationship: LONG_RELATIONSHIP } } }) }) };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const outcome = await updater.analyzePrivate(guildId, 'u1', [dmMessage({ id: 'm1', direct: true, ts: Date.UTC(2026, 0, 2, 10) })]);
    assert.equal(outcome.ok, true);
    assert.equal(store.getPrivate(guildId, 'u1').relationship, FIRST_SENTENCE);
  });
});

/** An updater whose analyzePrivate answers `{}` and hands back the partner's sent `<existing_profiles>` entry. */
function privateViewProbe(store, guildId, hot) {
  let sent = null;
  const llm = { complete: async (messages) => ((sent = messages), { text: '{}' }) };
  const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
  return async () => {
    await updater.analyzePrivate(guildId, 'u1', [dmMessage({ id: 'm1', direct: true, ts: Date.UTC(2026, 0, 2, 10) })]);
    return JSON.parse(blockBody(sent[1].content, 'existing_profiles')).u1;
  };
}

test('analyzePrivate: rewriteAfterMoves private moves since the private text is cause moves; public moves do not count', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const at = (hours) => ({ maxDelta: 15, historySize: 20, damping: false, truncate: false, now: TEXT_WRITTEN_MS + hours * 3600_000 });
    store.touchUser(guildId, 'u1', 'Zoé', Date.UTC(2026, 0, 1));
    store.adjustAffinity(guildId, 'u1', 10, 'public reason', at(-2));
    store.adjustPrivateAffinity(guildId, 'u1', 4, 'private reason', at(-1));
    store.applyPrivateOps(guildId, 'u1', { relationship: 'Μου τα λέει όλα.' }, { fieldChars: 400, relationshipScore: 14, now: TEXT_WRITTEN_MS });
    // Eight public moves after the private text, netting 0: the effective score stays 14 (warm).
    for (let i = 1; i <= 8; i += 1) store.adjustAffinity(guildId, 'u1', i % 2 ? 0.5 : -0.5, 'small', at(i));
    const viewOf = privateViewProbe(store, guildId, privateHot({}, { relationships: RELATIONSHIP_STALE_PIN }));

    assert.equal(store.getUser(guildId, 'u1').affinity.history.length, 9, 'the public moves are stored');
    let mine = await viewOf();
    assert.equal(mine.affinity.band, 'warm');
    assert.equal(mine.relationshipStale, undefined, 'public moves do not count toward the private text');

    for (let i = 1; i <= 5; i += 1) store.adjustPrivateAffinity(guildId, 'u1', i % 2 ? 0.5 : -0.5, 'small', at(10 + i));
    mine = await viewOf();
    assert.equal(mine.relationshipStale, undefined, 'five private moves, under rewriteAfterMoves (6)');

    store.adjustPrivateAffinity(guildId, 'u1', -0.5, 'small', at(16));
    mine = await viewOf();
    assert.deepEqual(mine.relationshipStale, { writtenAt: 'warm', now: 'warm', cause: 'moves' });
    assert.deepEqual(Object.keys(mine.affinity), ['score', 'band', 'reason'], 'the history itself is never shown');
  });
});

test('analyzePrivate: the private batch that writes the text does not count its own move; a later private move does', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, 'u1', 'Zoé', Date.UTC(2026, 0, 1));
    store.adjustAffinity(guildId, 'u1', 10, 'public reason', { maxDelta: 15, damping: false, now: TEXT_WRITTEN_MS - 3600_000 });
    const batchAt = (ms) => ({ relationships: { ...RELATIONSHIPS_CFG, now: ms } });
    applyPrivateUpdate(store, guildId, 'u1', { users: { u1: { relationship: 'Μου τα λέει όλα.', affinity: { delta: 3, reason: 'kind' } } } }, MEMORY_CFG, batchAt(TEXT_WRITTEN_MS));
    const priv = store.getPrivate(guildId, 'u1');
    assert.equal(priv.affinity.history.at(-1).ts, priv.relationshipWrittenAt, 'the private move and the text share the private batch clock');
    const viewOf = privateViewProbe(store, guildId, privateHot({}, { relationships: { rewriteAfterMoves: 1 } }));

    assert.equal((await viewOf()).relationshipStale, undefined);

    applyPrivateUpdate(store, guildId, 'u1', { users: { u1: { affinity: { delta: 1, reason: 'again' } } } }, MEMORY_CFG, batchAt(TEXT_WRITTEN_MS + 60_000));
    assert.equal((await viewOf()).relationshipStale.cause, 'moves', 'a later private move counts');
  });
});

// ---- two-stage analyzer, stage A (features.memoryTwoStage) -----------------

const DECIDE_PROMPT = 'decide prompt for {{name}}, relationship limit {{relationshipChars}}';
const STAGE_A_AT = Date.UTC(2026, 0, 9, 12);

/** A live view with the two-stage switch on and all three analyzer prompts present. */
/** `memoryOverrides.model`, when given (null included), is the extractor model (`models.base.extractor`). */
function twoStageHot(memoryOverrides = {}, configOverrides = {}) {
  const { model, ...memory } = memoryOverrides;
  const base = makeConfig();
  return {
    // relationships.textChars is pinned (the prompts below state it as {{relationshipChars}}).
    config: makeConfig({
      features: { memoryTwoStage: true },
      memory: { ...base.memory, ...memory },
      ...configOverrides,
      models: { base: { ...base.models.base, ...(Object.hasOwn(memoryOverrides, 'model') ? { extractor: model } : {}), ...configOverrides.models?.base } },
      relationships: { textChars: 600, ...configOverrides.relationships },
    }),
    prompts: { memory: 'memory system prompt', 'memory-decide': DECIDE_PROMPT, 'memory-voice': 'voice system prompt', labels },
  };
}

/** An llm whose every answer is `answer` (an object goes out as JSON); `calls` records each request. */
function recordingLlm(answer) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      return { text: typeof answer === 'string' ? answer : JSON.stringify(answer) };
    },
  };
}

/** The kinds of a guild's queued voice items, sorted. */
function queuedKinds(store, guildId) {
  return store.getVoiceQueue(guildId).map((item) => item.kind).sort();
}

test('analyzerMode: two only with the switch on and both prompts present', () => {
  const prompts = { memory: 'm', 'memory-decide': 'd', 'memory-voice': 'v' };
  const on = { features: { memoryTwoStage: true } };
  assert.equal(analyzerMode(on, prompts), 'two');
  assert.equal(analyzerMode({ features: { memoryTwoStage: false } }, prompts), 'single');
  assert.equal(analyzerMode({ features: {} }, prompts), 'single', 'a missing key counts as off');
  assert.equal(analyzerMode({ features: { memoryTwoStage: 'true' } }, prompts), 'single', 'read === true');
  assert.equal(analyzerMode(on, { ...prompts, 'memory-decide': '  \n' }), 'single', 'a blank stage A prompt');
  assert.equal(analyzerMode(on, { memory: 'm', 'memory-voice': 'v' }), 'single', 'no stage A prompt');
  assert.equal(analyzerMode(on, { memory: 'm', 'memory-decide': 'd' }), 'single', 'no voice prompt');
  assert.equal(analyzerMode(undefined, prompts), 'single');
  assert.equal(analyzerMode(on, undefined), 'single');
});

test('feedsCalibration: only a request on the voice model (models.base.voice) feeds the shared ratio', () => {
  const config = { models: { base: { voice: 'anthropic/claude-x' } } };
  assert.equal(feedsCalibration(config, 'anthropic/claude-x'), true);
  for (const unset of [null, undefined, '']) {
    assert.equal(feedsCalibration(config, unset), true, 'no model named: the request goes out on models.base.voice');
  }
  assert.equal(feedsCalibration(config, 'openai/gpt-y'), false);
  assert.equal(feedsCalibration({ models: { base: { voice: 'openai/gpt-y' } } }, 'openai/gpt-y'), true);
});

test('buildMemoryRequest: the decide stage uses memory-decide and leaves style out of the profile view', () => {
  const input = {
    prompts: { memory: 'single prompt for {{name}}', 'memory-decide': DECIDE_PROMPT, labels },
    config: makeConfig({ relationships: { textChars: 450 } }),
    calibrator: createCalibrator(),
    profiles: { 1: { names: ['Aria'], character: 'μιλάει πολύ', style: 'σύντομες φράσεις', relationship: 'φίλοι', interests: [], details: [] } },
    guildMemory: {},
    messages: [slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: STAGE_A_AT })],
    selfName: 'Nept',
    rosterProfiles: [poolProfile(ZOE, ['Zoé'], '2026-01-08T00:00:00.000Z')],
  };
  const single = buildMemoryRequest(input);
  const decide = buildMemoryRequest({ ...input, stage: 'decide' });

  assert.equal(single.messages[0].content, 'single prompt for Nept');
  assert.equal(decide.messages[0].content, 'decide prompt for Nept, relationship limit 450');
  const view = JSON.parse(blockBody(decide.messages[1].content, 'existing_profiles'))['1'];
  assert.equal(view.style, undefined, 'stage A writes no portrait');
  assert.equal(view.character, 'μιλάει πολύ');
  assert.equal(view.relationship, 'φίλοι');
  assert.equal(JSON.parse(blockBody(single.messages[1].content, 'existing_profiles'))['1'].style, 'σύντομες φράσεις');
  assert.equal(
    decide.messages[1].content,
    single.messages[1].content.replace(',"style":"σύντομες φράσεις"', ''),
    'the rest of the user message is the single-stage one',
  );
  const { messages: singleMessages, profilesTokens: singleProfilesTokens, ...singleFit } = single;
  const { messages: decideMessages, profilesTokens: decideProfilesTokens, ...decideFit } = decide;
  assert.equal(singleMessages.length, decideMessages.length);
  assert.deepEqual(decideFit, singleFit, 'roster, markers, fit and counts as in a single-stage request');
  assert.ok(decideProfilesTokens < singleProfilesTokens, 'the profiles block is smaller by the style left out');
  assert.deepEqual(decideFit.rosterIds, [ZOE]);
});

test('analyze (two-stage): neutral parts are stored at once and voice items queued; nothing waits for the voice model', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', STAGE_A_AT - 60_000);
    store.touchUser(guildId, ZOE, 'Zoé', STAGE_A_AT - DAY_MS); // a stored member: a lesson's known teacher
    store.adjustAffinity(guildId, '1', 10, 'παλιός λόγος', { maxDelta: 15, historySize: 10, damping: false, now: STAGE_A_AT - DAY_MS });
    store.updateGuild(guildId, { patterns: 'παλιά μοτίβα', starters: 'παλιές αρχές', self: ['λατρεύει τον καφέ', 'φοβάται τις αράχνες'] });
    const llm = recordingLlm({
      users: {
        1: {
          relationship: 'έγιναν φίλοι μετά το παιχνίδι',
          character: 'νέο πορτρέτο',
          style: 'νέο ύφος',
          portrait: 'ξαναδές το πορτρέτο',
          interests: { add: [{ topic: 'σκάκι', note: 'παίζει' }] },
          details: { add: [{ text: 'μένει κοντά στη θάλασσα' }] },
          aliases: { add: ['Αρι'] },
          affinity: { delta: 4, event: 'τη βοήθησε με το παζλ' },
          episodes: [{ date: '2026-01-09', what: 'έλυσαν μαζί ένα παζλ', quote: 'το βρήκα!', weight: 3, tone: 'χαρούμενη στιγμή' }],
        },
      },
      guild: {
        patterns: 'περισσότερα αστεία το βράδυ',
        starters: 'ερωτήσεις για παιχνίδια',
        injokes: ['η πάπια'],
        learned: { add: [{ brief: 'γκγκ σημαίνει καληνύχτα', from: `Zoé (id:${ZOE})` }] },
      },
      channels: { c1: { purpose: 'γενική κουβέντα' } },
      lore: [{ title: 'Η μεγάλη πάπια', keys: ['πάπια'], text: 'Ένα παλιό αστείο του σέρβερ.' }],
      self: { add: ['της αρέσουν τα παζλ'], remove: ['Φοβάται  τις αράχνες'] },
    });
    // Every read of the clock moves it: the split and the neutral write must share one value.
    let clock = STAGE_A_AT;
    const cues = [];
    const updater = createMemoryUpdater({
      hot: twoStageHot({}, { relationships: { damping: false } }),
      store,
      llm,
      calibrator: createCalibrator(),
      getSelfName: () => 'Nept',
      now: () => (clock += 1000),
      onPortraitRequest: (...args) => cues.push(args),
    });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1', channelId: 'c1', authorId: '1', authorName: 'Aria', content: 'το βρήκα!', ts: STAGE_A_AT })]);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.stage, 'two');
    assert.equal(llm.calls.length, 1, 'one stage A request per batch, no voice request');
    assert.equal(llm.calls[0].messages[0].content, 'decide prompt for Nept, relationship limit 600');

    const aria = store.getUser(guildId, '1');
    assert.deepEqual(aria.interests.map((item) => item.topic), ['σκάκι']);
    assert.deepEqual(aria.details.map((item) => item.text), ['μένει κοντά στη θάλασσα']);
    assert.deepEqual(aria.aliases.map((item) => item.name), ['Αρι']);
    assert.equal(aria.character, '', 'a portrait is never written from a stream batch');
    assert.equal(aria.style, '');
    assert.equal(aria.relationship, '', 'the relationship waits for the voice model');
    assert.equal(aria.affinity.score, 14, 'the delta lands at once');
    assert.equal(aria.affinity.reason, 'παλιός λόγος', 'the stored reason stays until the worded one arrives');
    const move = aria.affinity.history.at(-1);
    assert.equal(move.delta, 4);
    assert.equal(aria.episodes.length, 1);
    const [episode] = aria.episodes;
    assert.equal(episode.what, 'έλυσαν μαζί ένα παζλ');
    assert.equal(episode.quote, 'το βρήκα!');
    assert.equal(episode.weight, 3);
    assert.equal(episode.feeling, '', 'stored at once with an empty feeling');

    const guild = store.getGuild(guildId);
    assert.equal(guild.patterns, 'παλιά μοτίβα', 'server notes wait for the voice model');
    assert.equal(guild.starters, 'παλιές αρχές');
    assert.deepEqual(guild.injokes, ['η πάπια']);
    assert.deepEqual(guild.learned, [], 'a lesson waits for the voice model');
    assert.deepEqual(guild.self, ['λατρεύει τον καφέ'], 'a removal applies at once, an addition waits');
    assert.equal(store.getChannel(guildId, 'c1').purpose, 'γενική κουβέντα');
    assert.deepEqual(store.getLore(guildId).map((entry) => entry.title), ['Η μεγάλη πάπια']);

    const queue = store.getVoiceQueue(guildId);
    assert.deepEqual(queuedKinds(store, guildId), ['feeling', 'learned', 'patterns', 'reason', 'relationship', 'self', 'starters']);
    const byKind = Object.fromEntries(queue.map((item) => [item.kind, item]));
    assert.equal(byKind.relationship.userId, '1');
    assert.deepEqual(byKind.relationship.brief, ['έγιναν φίλοι μετά το παιχνίδι']);
    assert.deepEqual(byKind.reason.brief, ['τη βοήθησε με το παζλ']);
    assert.deepEqual(byKind.reason.payload, { delta: 4, at: move.ts });
    assert.deepEqual(byKind.feeling.brief, ['χαρούμενη στιγμή']);
    assert.deepEqual(byKind.feeling.payload, { at: episode.addedAt, date: '2026-01-09', what: episode.what, quote: 'το βρήκα!' });
    assert.equal(move.ts, episode.addedAt, 'the split and the neutral write share one clock value');
    assert.equal(byKind.learned.payload.from, `<@${ZOE}>`, 'the teacher reference turned into the token');
    assert.deepEqual(byKind.self.brief, ['της αρέσουν τα παζλ']);
    assert.ok(queue.every((item) => item.layer === undefined), 'public items');

    assert.equal(outcome.result.voiceQueued, 7);
    assert.equal(outcome.result.portraitDropped, 3, 'character, style and the portrait cue, counted');
    assert.deepEqual(cues, [], 'no portrait cue from stage A');
    assert.equal(outcome.result.self, true);
    assert.equal(outcome.result.affinity, 1);
    assert.equal(outcome.result.episodes, 1);
    assert.equal(outcome.result.relationships, 0);

    // The address a queued item carries is one the store's fill functions (the voice run's writes) find.
    assert.equal(store.fillAffinityReason(guildId, '1', byKind.reason.payload.at, 'τη βοήθησε'), true);
    assert.equal(store.fillEpisodeFeeling(guildId, '1', byKind.feeling.payload, 'χάρηκε'), true);
    assert.equal(store.getUser(guildId, '1').affinity.reason, 'τη βοήθησε');
    assert.equal(store.getUser(guildId, '1').episodes[0].feeling, 'χάρηκε');
  });
});

test('analyze (two-stage): a self claim naming a member is never queued, a removal of one still applies', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', STAGE_A_AT - 60_000);
    store.touchUser(guildId, ZOE, 'Zoé', STAGE_A_AT - DAY_MS);
    const old = `<@${ZOE}> είναι η αγαπημένη μου`;
    store.updateGuild(guildId, { self: ['λατρεύει τον καφέ', old] });
    const llm = recordingLlm({
      self: { add: ['της αρέσουν τα παζλ', `<@${ZOE}> δεν βαριέται ποτέ`, 'η ARIA είναι η αγαπημένη της'], remove: [old] },
    });
    const updater = createMemoryUpdater({ hot: twoStageHot(), store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => STAGE_A_AT });

    const { result: outcome, logs } = await withCapturedLogs(() =>
      updater.analyze(guildId, [slimMessage({ id: 'm1', channelId: 'c1', authorId: '1', authorName: 'Aria', content: 'γεια', ts: STAGE_A_AT })]),
    );

    assert.equal(outcome.ok, true);
    assert.equal(outcome.stage, 'two');
    const selfItems = store.getVoiceQueue(guildId).filter((item) => item.kind === 'self');
    assert.deepEqual(selfItems.map((item) => item.brief), [['της αρέσουν τα παζλ']]);
    assert.deepEqual(store.getGuild(guildId).self, ['λατρεύει τον καφέ'], 'the removal is not filtered');
    assert.equal(outcome.result.self, true);
    assert.equal(outcome.result.selfDropped, 2);
    const dropped = logs.filter((entry) => entry.msg === SELF_DROP_LOG);
    assert.deepEqual(dropped.map(({ guildId: id, count }) => ({ id, count })), [{ id: guildId, count: 2 }]);
  });
});

test('analyze (two-stage): stage A goes to models.base.extractor with role extractor and skips calibration when that model is not models.base.voice', async () => {
  const cases = [
    { model: 'openai/gpt-z', sent: 'openai/gpt-z', skip: true },
    { model: null, sent: ROLE_DEFAULTS.extractor, skip: true },
    { model: 'x/y', sent: 'x/y', skip: false },
  ];
  for (const { model, sent, skip } of cases) {
    await withStoreAsync(async (store) => {
      const llm = recordingLlm({});
      const hot = twoStageHot({ model, maxOutputTokens: 5555, timeoutMs: 4321, temperature: 0.2 });
      const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

      const outcome = await updater.analyze('g1', [slimMessage({ id: 'm1' })]);

      assert.equal(outcome.ok, true);
      const [{ options }] = llm.calls;
      assert.equal(options.model, sent, `models.base.extractor ${model}`);
      assert.equal(options.role, 'extractor');
      assert.equal(options.skipCalibration, skip, `models.base.extractor ${model}`);
      assert.equal(options.maxOutputTokens, 5555);
      assert.equal(options.timeoutMs, 4321);
      assert.equal(options.temperature, 0.2);
    });
  }
});

test('analyze (two-stage): an alias for a known_members member is stored by stage A alone', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', STAGE_A_AT);
    store.touchUser(guildId, ZOE, 'Zoé-42%', STAGE_A_AT - DAY_MS);
    const llm = recordingLlm({
      users: {
        [ZOE]: {
          aliases: { add: ['Ζωή'] },
          relationship: 'δεν έγραψε τίποτα',
          affinity: { delta: 3, event: 'την ανέφεραν' },
          episodes: [{ what: 'την ανέφεραν', tone: 'ουδέτερο' }],
          interests: { add: [{ topic: 'ποίηση', note: '' }] },
        },
      },
    });
    const updater = createMemoryUpdater({ hot: twoStageHot(), store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => STAGE_A_AT });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', content: 'η Ζωή είναι η zoé 42', ts: STAGE_A_AT })]);

    assert.equal(outcome.ok, true);
    assert.deepEqual(Object.keys(JSON.parse(blockBody(llm.calls[0].messages[1].content, 'known_members'))), [ZOE]);
    const zoe = store.getUser(guildId, ZOE);
    assert.deepEqual(zoe.aliases.map((item) => item.name), ['Ζωή']);
    assert.equal(zoe.affinity.score, 0, 'no attitude move for a member who wrote nothing');
    assert.deepEqual(zoe.episodes, []);
    assert.deepEqual(zoe.interests, []);
    assert.deepEqual(store.getVoiceQueue(guildId), [], 'no voice item for a roster member');
    assert.equal(outcome.result.aliasOnly, 1);
    assert.equal(outcome.result.droppedFields, 3, 'affinity, episodes and interests');
    assert.equal(outcome.result.voiceDropped, 3, 'the relationship, reason and feeling briefs');
  });
});

test('analyze (two-stage): a reason whose score did not move and a feeling whose moment is already stored are not queued', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', STAGE_A_AT);
    store.adjustAffinity(guildId, '1', 100, 'λατρεία', { maxDelta: 100, historySize: 10, damping: false, now: STAGE_A_AT - DAY_MS });
    store.addEpisodes(guildId, '1', [{ date: '2026-01-08', what: 'μοιράστηκαν ένα τραγούδι', weight: 2 }], { maxEpisodes: 20, now: STAGE_A_AT - DAY_MS });
    const llm = recordingLlm({
      users: {
        1: {
          affinity: { delta: 5, event: 'πάλι καλή' },
          episodes: [
            { date: '2026-01-08', what: 'Μοιράστηκαν  ένα τραγούδι', tone: 'ζεστό' },
            { date: '2026-01-09', what: 'της έφερε λουλούδια', tone: 'έκπληξη' },
          ],
        },
      },
    });
    const updater = createMemoryUpdater({ hot: twoStageHot(), store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => STAGE_A_AT });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: STAGE_A_AT })]);

    assert.equal(outcome.ok, true);
    assert.equal(store.getUser(guildId, '1').affinity.score, 100, 'at its bound: the score did not move');
    const queue = store.getVoiceQueue(guildId);
    assert.deepEqual(queue.map((item) => item.kind), ['feeling'], 'nothing to fill for the other two');
    assert.equal(queue[0].payload.what, 'της έφερε λουλούδια');
    assert.equal(outcome.result.voiceQueued, 1);
    assert.equal(outcome.result.voiceDropped, 2);
  });
});

test('analyze (two-stage): items pushed past memory.voice.queueMax take the degraded path at once', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const earlier = STAGE_A_AT - 3_600_000;
    const hot = twoStageHot({ voice: { queueMax: 2 } });
    store.touchUser(guildId, '1', 'Aria', earlier);
    store.addEpisodes(guildId, '1', [{ date: '2026-01-09', what: 'γέλασαν με την πάπια', feeling: '' }], { maxEpisodes: 20, now: earlier });
    store.updateVoiceQueue(guildId, (queue) =>
      mergeIntoQueue(
        queue,
        [
          { kind: 'feeling', userId: '1', brief: ['ήσυχη χαρά'], payload: { at: new Date(earlier).toISOString(), date: '2026-01-09', what: 'γέλασαν με την πάπια', quote: '' } },
          { kind: 'self', brief: ['λατρεύει τα μήλα'] },
        ],
        earlier,
        hot.config,
      ),
    );
    const llm = recordingLlm({ users: { 1: { relationship: 'καλή παρέα' } }, guild: { patterns: 'πολλά αστεία' } });
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => STAGE_A_AT });

    const { result: outcome, logs } = await withCapturedLogs(() =>
      updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: STAGE_A_AT })]),
    );

    assert.equal(outcome.ok, true);
    assert.deepEqual(queuedKinds(store, guildId), ['patterns', 'relationship'], 'the two oldest overflowed');
    assert.equal(store.getUser(guildId, '1').episodes[0].feeling, 'ήσυχη χαρά', 'an overflowing feeling keeps the stage A tone');
    assert.deepEqual(store.getGuild(guildId).self, ['λατρεύει τα μήλα'], 'an overflowing self fact is stored from its brief');
    assert.equal(outcome.result.voiceQueued, 2);
    assert.equal(outcome.result.voiceOverflow, 2);
    assert.equal(outcome.result.voiceDegraded, 2);
    const dropped = logs.find((entry) => entry.msg === 'memory: voice dropped');
    assert.deepEqual(
      { guildId: dropped.guildId, expired: dropped.expired, overflow: dropped.overflow, degraded: dropped.degraded },
      { guildId, expired: 0, overflow: 2, degraded: 2 },
    );
    assert.ok(!JSON.stringify(logs).includes('ήσυχη'), 'counts only');
  });
});

test('analyze (two-stage): an item queued while the stage A request is in flight is kept', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', STAGE_A_AT);
    const hot = twoStageHot();
    const llm = {
      complete: async () => {
        // A portrait refresh queues a character item meanwhile.
        store.updateVoiceQueue(guildId, (queue) => mergeIntoQueue(queue, [{ kind: 'character', userId: '1', brief: { add: ['γράφει σύντομα'] } }], STAGE_A_AT, hot.config));
        return { text: JSON.stringify({ users: { 1: { relationship: 'φιλικά' } } }) };
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => STAGE_A_AT });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: STAGE_A_AT })]);

    assert.equal(outcome.ok, true);
    assert.deepEqual(queuedKinds(store, guildId), ['character', 'relationship']);
  });
});

test('analyze (two-stage): a missing memory-decide prompt runs the single-stage request on models.base.voice and warns once per change', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', STAGE_A_AT);
    // The fallback is a memory-wording request: it needs the voice rail config.json ships.
    const hot = twoStageHot({ model: 'openai/gpt-z', voice: { maxPerDay: 100 } });
    delete hot.prompts['memory-decide'];
    const llm = recordingLlm({ users: { 1: { relationship: 'φίλοι από παλιά' } } });
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => STAGE_A_AT });
    const batch = (id) => [slimMessage({ id, authorId: '1', authorName: 'Aria', ts: STAGE_A_AT })];

    const { result: outcomes, logs } = await withCapturedLogs(async () => {
      const seen = [await updater.analyze(guildId, batch('m1')), await updater.analyze(guildId, batch('m2'))];
      hot.prompts['memory-decide'] = DECIDE_PROMPT;
      seen.push(await updater.analyze(guildId, batch('m3')));
      delete hot.prompts['memory-decide'];
      seen.push(await updater.analyze(guildId, batch('m4')));
      return seen;
    });

    assert.deepEqual(outcomes.map((outcome) => outcome.stage), ['single', 'single', 'two', 'single']);
    assert.deepEqual(
      llm.calls.map((call) => call.messages[0].content),
      ['memory system prompt', 'memory system prompt', 'decide prompt for Nept, relationship limit 600', 'memory system prompt'],
    );
    assert.deepEqual(
      llm.calls.map((call) => call.options.model),
      [undefined, undefined, 'openai/gpt-z', undefined],
      'the fallback words every voice text, so it goes out on models.base.voice, never on models.base.extractor',
    );
    assert.deepEqual(
      llm.calls.map((call) => call.options.skipCalibration),
      [false, false, true, false],
      'only models.base.voice feeds the calibration',
    );
    assert.equal(store.getUser(guildId, '1').relationship, 'φίλοι από παλιά', 'the single-stage answer is applied as today');
    const warnings = logs.filter((entry) => entry.msg === 'memory: two-stage unavailable');
    assert.equal(warnings.length, 2, 'once when it became unavailable, once more after it came back and went again');
    for (const warning of warnings) {
      assert.equal(warning.level, 'warn');
      assert.equal(warning.reason, 'no-prompt');
      assert.deepEqual(warning.missing, ['memory-decide']);
    }
  });
});

test('analyze (two-stage): the single-stage fallback goes out on models.base.voice as a memory-wording request, never on models.base.extractor or a stale memory.voiceModel; with the switch off as before', async () => {
  const optionsOf = (hot) =>
    withStoreAsync(async (store) => {
      const llm = recordingLlm({});
      const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
      const { result: outcome } = await withCapturedLogs(() => updater.analyze('g1', [slimMessage({ id: 'm1' })]));
      assert.equal(outcome.ok, true);
      return llm.calls[0].options;
    });
  const fallback = (memory) => {
    const hot = twoStageHot({ model: 'openai/gpt-z', reasoning: { effort: 'low' }, voice: { maxPerDay: 100 }, ...memory });
    delete hot.prompts['memory-voice'];
    return hot;
  };

  const plain = await optionsOf(fallback({}));
  const stale = await optionsOf(fallback({ voiceModel: 'anthropic/voice-v' }));
  for (const options of [plain, stale]) {
    assert.equal(options.model, undefined, 'models.base.voice, whatever memory.voiceModel says');
    assert.equal(options.skipCalibration, false, 'models.base.voice feeds the shared ratio');
    assert.equal(options.role, 'voice', 'role voice: the provider pin of that role covers it');
    assert.equal(options.purpose, 'memory-voice');
    assert.equal(options.cache, false, 'never cache-marked: the marker stays on the reply');
    assert.equal('reasoning' in options, false, 'the stage A reasoning setting stays with stage A');
  }

  const off = twoStageHot({ model: 'openai/gpt-z', reasoning: { effort: 'low' } });
  off.config.features.memoryTwoStage = false;
  const today = await optionsOf(off);
  assert.equal(today.model, 'openai/gpt-z', 'with the switch off the request goes out on models.base.extractor, as before');
  assert.equal(today.role, 'extractor');
  assert.equal('purpose' in today, false);
  assert.equal('cache' in today, false);
  assert.equal('skipCalibration' in today, false);
  assert.equal('reasoning' in today, false);
});

test('analyze (two-stage): the single-stage fallback counts against memory.voice.maxPerDay; past the rail nothing is sent and the batch backs off', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const clock = STAGE_A_AT;
    store.touchUser(guildId, '1', 'Aria', clock - MINUTE_MS);
    const hot = twoStageHot({ batchMessages: 1, minBatchMessages: 1, voice: { maxPerDay: 1 } });
    delete hot.prompts['memory-decide'];
    let refusal = null;
    const calls = [];
    const llm = {
      complete: async (messages, options) => {
        calls.push(options);
        if (refusal) throw refusal;
        return { text: '{}' };
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => clock });
    const batch = [slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: clock - 1000 })];

    const { result: outcomes } = await withCapturedLogs(async () => {
      const seen = [];
      for (const error of [new TokenLimitError('request estimated over the cap'), new DailyCapError('daily LLM request cap reached')]) {
        refusal = error;
        seen.push(await updater.analyze(guildId, batch));
        assert.equal(store.state.data.voiceCount, 0, `${error.name}: refused before sending, the count is given back`);
      }
      refusal = null;
      seen.push(await updater.analyze(guildId, batch));
      seen.push(await updater.analyze(guildId, batch));
      return seen;
    });

    assert.deepEqual(outcomes.map((outcome) => outcome.ok), [false, false, true, false]);
    assert.equal(outcomes[3].reason, 'daily-cap');
    assert.equal(outcomes[3].stage, 'single');
    assert.equal(calls.length, 3, 'the batch past the rail is never sent');
    assert.ok(calls.every((options) => options.role === 'voice' && options.purpose === 'memory-voice'));
    assert.equal(store.state.data.voiceCount, 1, 'the request that went out counts');
    assert.equal(store.state.data.voiceDay, utcDay(clock));

    // Through run(): the refusal backs the guild off (it is not the batch's size), the buffer stays.
    store.pushBuffer(guildId, batch[0], 100);
    const { logs } = await withCapturedLogs(() => updater.run(guildId));
    const failed = logs.find((entry) => entry.msg === 'memory: update failed, backing off');
    assert.deepEqual({ reason: failed.reason, stage: failed.stage }, { reason: 'daily-cap', stage: 'single' });
    assert.equal(store.getBuffer(guildId).length, 1);
    assert.equal(calls.length, 3);

    for (const maxPerDay of [0, undefined, '100']) {
      hot.config.memory.voice = { maxPerDay };
      store.state.data.voiceDay = undefined;
      const { result } = await withCapturedLogs(() => updater.analyze(guildId, batch));
      assert.equal(result.reason, 'daily-cap', `maxPerDay ${JSON.stringify(maxPerDay)}`);
    }
    assert.equal(calls.length, 3, 'never sent');
  });
});

test('analyze (two-stage): memory.reasoning, a plain object, goes with every stage A request and no other', async () => {
  const reasoning = { effort: 'low' };
  const optionsOf = (hot, { privately = false } = {}) =>
    withStoreAsync(async (store) => {
      const llm = recordingLlm({});
      if (privately) seedPrivate(store, 'g1');
      const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
      const { result: outcome } = await withCapturedLogs(() =>
        privately
          ? updater.analyzePrivate('g1', 'u1', [dmMessage({ id: 'm1', direct: true })])
          : updater.analyze('g1', [slimMessage({ id: 'm1' })]),
      );
      assert.equal(outcome.ok, true);
      return llm.calls[0].options;
    });

  assert.deepEqual((await optionsOf(twoStageHot({ model: 'openai/gpt-z', reasoning }))).reasoning, reasoning, 'a guild stage A');
  assert.deepEqual((await optionsOf(twoStageHot({ model: 'openai/gpt-z', reasoning }), { privately: true })).reasoning, reasoning, 'a private stage A');
  for (const odd of ['low', ['effort'], null]) {
    assert.equal('reasoning' in (await optionsOf(twoStageHot({ model: 'openai/gpt-z', reasoning: odd }))), false, `not sent: ${JSON.stringify(odd)}`);
  }
  assert.equal('reasoning' in (await optionsOf(twoStageHot({ model: 'openai/gpt-z' }))), false, 'no key, nothing sent');
});

test('run (two-stage): a failed stage A request backs off, an answer the store refuses is apply-error; every line says stage two', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now() - 2000);
    store.pushBuffer(guildId, slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: Date.now() - 1000 }), 100);
    let call = 0;
    const llm = {
      complete: async () => {
        call += 1;
        if (call === 1) throw new Error('provider unavailable');
        return { text: JSON.stringify({ users: { 1: { relationship: 'ήρεμα' } } }) };
      },
    };
    const updater = createMemoryUpdater({ hot: twoStageHot({ batchMessages: 1, minBatchMessages: 1 }), store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const { logs: failedLogs } = await withCapturedLogs(() => updater.run(guildId));
    const backedOff = failedLogs.find((entry) => entry.msg === 'memory: update failed, backing off');
    assert.equal(backedOff.reason, 'llm-error');
    assert.equal(backedOff.stage, 'two');

    store.updateVoiceQueue = () => {
      throw new TypeError('the queue is refused');
    };
    const { logs: refusedLogs } = await withCapturedLogs(() => updater.run(guildId));
    const warned = refusedLogs.find((entry) => entry.msg === 'memory: the analyzer answer could not be applied');
    assert.equal(warned.reason, 'apply-error');
    assert.equal(warned.stage, 'two');
    const refused = refusedLogs.find((entry) => entry.msg === 'memory: update failed, backing off');
    assert.equal(refused.reason, 'apply-error');
    assert.equal(refused.stage, 'two');
    assert.equal(store.getBuffer(guildId).length, 1, 'neither batch is consumed');
  });
});

test('run: a DailyCapError from stage A or from a single-stage batch logs reason daily-cap and backs off, never halves', async () => {
  const single = () => ({ config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 1, minBatchMessages: 1 } }), prompts: { memory: 'sys', labels } });
  for (const [name, hotOf] of [
    ['stage A', () => twoStageHot({ batchMessages: 1, minBatchMessages: 1 })],
    ['single', single],
  ]) {
    await withStoreAsync(async (store) => {
      const guildId = 'g1';
      store.pushBuffer(guildId, slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: STAGE_A_AT }), 100);
      let calls = 0;
      const llm = { complete: async () => { calls += 1; throw new DailyCapError('daily LLM request cap reached'); } };
      const updater = createMemoryUpdater({ hot: hotOf(), store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => STAGE_A_AT });

      const { logs } = await withCapturedLogs(() => updater.run(guildId));

      const failures = logs.filter((entry) => entry.msg.startsWith('memory: update failed'));
      assert.deepEqual(failures.map((entry) => [entry.msg, entry.reason]), [['memory: update failed, backing off', 'daily-cap']], name);
      assert.equal(store.getBuffer(guildId).length, 1, `${name}: nothing consumed`);
      await updater.tick();
      assert.equal(calls, 1, `${name}: backed off, not retried at once`);
    });
  }
});

test('analyze (two-stage): an overflowing lesson is stored from its brief with its teacher, sure:false and its seenAt', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const taughtAt = STAGE_A_AT - DAY_MS; // the first batch's newest message
    store.touchUser(guildId, '1', 'Aria', taughtAt - 60_000);
    store.touchUser(guildId, ZOE, 'Zoé', taughtAt - DAY_MS); // a stored member: a known teacher
    const hot = twoStageHot();
    const answers = [
      { guild: { learned: { add: [{ brief: 'γκγκ σημαίνει καληνύχτα', from: `Zoé (id:${ZOE})`, sure: false }] } } },
      { users: { 1: { relationship: 'καλή παρέα' } } },
    ];
    const llm = { complete: async () => ({ text: JSON.stringify(answers.shift()) }) };
    let clock = taughtAt + 60_000;
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => clock });
    const batch = (id, ts) => [slimMessage({ id, authorId: '1', authorName: 'Aria', ts })];

    assert.equal((await updater.analyze(guildId, batch('m1', taughtAt))).ok, true);
    assert.deepEqual(queuedKinds(store, guildId), ['learned']);
    assert.deepEqual(store.getGuild(guildId).learned, [], 'queued, not stored');

    hot.config.memory.voice = { queueMax: 1 }; // a live edit: the next batch pushes the lesson out
    clock = STAGE_A_AT;
    const { result: outcome } = await withCapturedLogs(() => updater.analyze(guildId, batch('m2', STAGE_A_AT)));

    assert.equal(outcome.ok, true);
    assert.deepEqual(queuedKinds(store, guildId), ['relationship']);
    assert.equal(outcome.result.voiceOverflow, 1);
    assert.equal(outcome.result.voiceDegraded, 1);
    const [lesson, ...rest] = store.getGuild(guildId).learned;
    assert.deepEqual(rest, []);
    assert.equal(lesson.text, 'γκγκ σημαίνει καληνύχτα', 'stored from its brief');
    assert.equal(lesson.from, `<@${ZOE}>`, 'with its teacher');
    assert.equal(lesson.weight, 0, 'sure: false');
    assert.equal(lesson.firstSeen, new Date(taughtAt).toISOString(), 'dated when it was taught, not when it overflowed');
  });
});

test('analyzePrivate (two-stage): an overflowing private feeling lands in the private layer only', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    seedPrivate(store, guildId);
    const first = Date.UTC(2026, 0, 2, 11);
    const moment = { date: '2026-01-02', what: 'της είπε ένα μυστικό' };
    // The same moment in the public profile under the same address: a write that lost its layer would fill it.
    store.addEpisodes(guildId, 'u1', [{ ...moment, feeling: '' }], { maxEpisodes: 20, now: first });
    const hot = twoStageHot();
    const answers = [
      { users: { u1: { episodes: [{ ...moment, weight: 4, tone: 'εμπιστοσύνη' }] } } },
      { users: { u1: { relationship: 'μιλούν κάθε βράδυ' } } },
    ];
    const llm = { complete: async () => ({ text: JSON.stringify(answers.shift()) }) };
    let clock = first;
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => clock });
    const dm = (id, ts) => [dmMessage({ id, content: 'γεια σου', direct: true, ts })];

    assert.equal((await updater.analyzePrivate(guildId, 'u1', dm('m1', first - 60_000))).ok, true);
    assert.deepEqual(queuedKinds(store, guildId), ['feeling']);
    assert.equal(store.getPrivate(guildId, 'u1').episodes.at(-1).addedAt, store.getUser(guildId, 'u1').episodes[0].addedAt, 'one address in both layers');
    const publicBefore = JSON.stringify(store.getUser(guildId, 'u1'));

    hot.config.memory.voice = { queueMax: 1 }; // a live edit: the next batch pushes the feeling out
    clock = first + 3_600_000;
    const { result: outcome } = await withCapturedLogs(() => updater.analyzePrivate(guildId, 'u1', dm('m2', clock - 60_000)));

    assert.equal(outcome.ok, true);
    assert.deepEqual(queuedKinds(store, guildId), ['relationship']);
    assert.equal(outcome.result.voiceOverflow, 1);
    assert.equal(outcome.result.voiceDegraded, 1);
    const stored = store.getPrivate(guildId, 'u1').episodes.find((ep) => ep.what === moment.what);
    assert.equal(stored.feeling, 'εμπιστοσύνη', 'the stage A tone, in the private layer');
    assert.equal(JSON.stringify(store.getUser(guildId, 'u1')), publicBefore, 'the public profile is untouched');
    assert.equal(store.getUser(guildId, 'u1').episodes[0].feeling, '');
  });
});

test('analyze (two-stage): a memory.maxSelfFacts that is not a number counts as missing, and a self.remove still applies', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const cap = MEMORY_LIMIT_DEFAULTS.maxSelfFacts;
    store.touchUser(guildId, '1', 'Aria', STAGE_A_AT);
    store.updateGuild(guildId, { self: Array.from({ length: cap }, (_, i) => `γεγονός ${i}`) });
    // Three claims, room for one in the queue: the two oldest overflow and are stored from their briefs.
    const hot = twoStageHot({ maxSelfFacts: 'είκοσι', voice: { queueMax: 1 } });
    const llm = recordingLlm({ self: { remove: ['γεγονός 0'], add: ['νέο α', 'νέο β', 'νέο γ'] } });
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => STAGE_A_AT });

    const { result: outcome } = await withCapturedLogs(() =>
      updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: STAGE_A_AT })]),
    );

    assert.equal(outcome.ok, true, 'never an apply-error');
    assert.equal(outcome.result.self, true, 'the removal applied');
    assert.equal(outcome.result.voiceOverflow, 2);
    assert.equal(outcome.result.voiceDegraded, 2);
    const { self } = store.getGuild(guildId);
    assert.equal(self.length, cap, 'capped at the fallback limit');
    assert.ok(!self.includes('γεγονός 0'), 'removed by stage A');
    assert.ok(!self.includes('γεγονός 1'), 'the oldest left to make room');
    assert.deepEqual(self.slice(-2), ['νέο α', 'νέο β']);
    assert.deepEqual(store.getVoiceQueue(guildId).map((item) => item.brief), [['νέο γ']]);
  });
});

test('run (two-stage): a stage A answer that does not parse is bad-json: the buffer stays, nothing is queued, the next batch is halved', async () => {
  await withStoreAsync(async (store, dir) => {
    const guildId = 'g1';
    const base = Date.now();
    store.touchUser(guildId, '1', 'nick', base);
    for (let i = 0; i < 90; i += 1) {
      store.pushBuffer(guildId, slimMessage({ id: `m${i}`, content: `hi ${i}`, ts: base + i * 1000 }), 200);
    }
    const hot = twoStageHot({ batchMessages: 15, minBatchMessages: 1 });
    let call = 0;
    const llm = {
      complete: async () => {
        call += 1;
        if (call === 1) return { text: 'κανένα αντικείμενο εδώ', usage: { prompt_tokens: 10, completion_tokens: 5 } };
        return { text: JSON.stringify({ users: { 1: { relationship: 'ήρεμα' } } }) };
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));

    assert.equal(store.getBuffer(guildId).length, 90, 'a failed batch is never consumed');
    assert.deepEqual(store.getVoiceQueue(guildId), [], 'nothing queued');
    assert.equal(store.getUser(guildId, '1').relationship, '');
    const failed = logs.find((entry) => entry.msg === 'memory: update failed, halving the batch size for next time');
    assert.ok(failed, 'halved as today');
    assert.equal(failed.reason, 'bad-json');
    assert.equal(failed.stage, 'two');
    assert.ok(!JSON.stringify(logs).includes('αντικείμενο'), 'never the answer');

    await updater.run(guildId);
    assert.equal(store.getBuffer(guildId).length, 70, '20 consumed (half of 30, floored at 20), not 30');
    assert.deepEqual(queuedKinds(store, guildId), ['relationship']);
    assert.ok(fs.existsSync(path.join(dir, 'guilds', guildId, 'voice.json')), 'the queue is flushed with the batch');
  });
});

test('analyzePrivate (two-stage): the same split; the neutral part lands in the private layer only and the items are queued as private', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    seedPrivate(store, guildId);
    const publicBefore = JSON.stringify(store.getUser(guildId, 'u1'));
    const guildBefore = JSON.stringify(store.getGuild(guildId));
    const llm = recordingLlm({
      users: {
        u1: {
          relationship: 'μιλούν κάθε βράδυ',
          interests: { add: [{ topic: 'ποίηση', note: 'γράφει' }] },
          aliases: { add: ['Ζω'] },
          character: 'νέο πορτρέτο',
          affinity: { delta: 2, event: 'της είπε ένα μυστικό' },
          episodes: [{ date: '2026-01-02', what: 'της είπε ένα μυστικό', weight: 4, tone: 'εμπιστοσύνη' }],
        },
      },
      guild: { patterns: 'μοτίβο από ιδιωτική κουβέντα', injokes: ['ιδιωτικό αστείο'] },
      self: { add: ['ιδιωτικός ισχυρισμός'], remove: ['παλιό γεγονός'] },
    });
    const hot = twoStageHot({}, { relationships: { damping: false } });
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => Date.UTC(2026, 0, 2, 11) });

    const outcome = await updater.analyzePrivate(guildId, 'u1', [dmMessage({ id: 'm1', content: 'γεια σου', direct: true, ts: Date.UTC(2026, 0, 2, 10) })]);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.stage, 'two');
    assert.equal(llm.calls.length, 1);
    const [{ messages, options }] = llm.calls;
    assert.equal(messages[0].content, 'decide prompt for Nept, relationship limit 600');
    assert.equal(blockBody(messages[1].content, 'private'), labels.memory.privateNote);
    assert.equal(options.role, 'extractor');

    assert.equal(JSON.stringify(store.getUser(guildId, 'u1')), publicBefore, 'nothing public is written');
    assert.equal(JSON.stringify(store.getGuild(guildId)), guildBefore, 'nor anything of the server');
    const priv = store.getPrivate(guildId, 'u1');
    assert.ok(priv.interests.some((item) => item.topic === 'ποίηση'));
    assert.equal(priv.affinity.score, 6, 'private 4 + 2, at once');
    assert.equal(priv.affinity.reason, 'private reason', 'kept until the worded one arrives');
    assert.equal(priv.relationship, '', 'waits for the voice model');
    const episode = priv.episodes.at(-1);
    assert.equal(episode.what, 'της είπε ένα μυστικό');
    assert.equal(episode.feeling, '');

    const queue = store.getVoiceQueue(guildId);
    assert.deepEqual(queuedKinds(store, guildId), ['feeling', 'reason', 'relationship']);
    assert.ok(queue.every((item) => item.layer === 'private' && item.userId === 'u1'), 'private items of the partner only');
    assert.equal(queue.find((item) => item.kind === 'reason').payload.at, priv.affinity.history.at(-1).ts);
    assert.equal(queue.find((item) => item.kind === 'feeling').payload.at, episode.addedAt);
    assert.equal(outcome.result.dropped.guild, true);
    assert.equal(outcome.result.dropped.portrait, 1);
    assert.equal(outcome.result.dropped.self, 2, 'the self claims of a private batch, added or removed, are dropped and counted');
    assert.equal(outcome.result.voiceQueued, 3);

    // The private addresses are the ones the store's fill functions find in the private layer.
    const reason = queue.find((item) => item.kind === 'reason');
    const feeling = queue.find((item) => item.kind === 'feeling');
    assert.equal(store.fillAffinityReason(guildId, 'u1', reason.payload.at, 'της εμπιστεύτηκε κάτι', { layer: 'private' }), true);
    assert.equal(store.fillEpisodeFeeling(guildId, 'u1', feeling.payload, 'συγκινήθηκε', { layer: 'private' }), true);
    assert.equal(store.getPrivate(guildId, 'u1').affinity.reason, 'της εμπιστεύτηκε κάτι');
    assert.equal(JSON.stringify(store.getUser(guildId, 'u1')), publicBefore, 'still nothing public');
  });
});

// ---- two-stage analyzer, stage B: the voice run (runVoice) -----------------

const VOICE_PROMPT = 'voice prompt for {{name}}: relationship {{relationshipChars}}, portrait {{fieldChars}}';
const VOICE_AT = Date.UTC(2026, 0, 10, 12);

/**
 * twoStageHot with the voice rail a deployment's config.json carries: makeConfig has no
 * `memory.voice`, and a missing `memory.voice.maxPerDay` refuses every voice request (fail
 * closed). A `voice` override is merged into it.
 */
function voiceHot(memoryOverrides = {}, configOverrides = {}) {
  const { voice, ...memory } = memoryOverrides;
  const hot = twoStageHot({ voice: { maxPerDay: 100, ...voice }, ...memory }, configOverrides);
  hot.prompts['memory-voice'] = VOICE_PROMPT;
  return hot;
}

/** Queue `items` (mergeIntoQueue's input shape) in a guild's voice queue as of `nowMs`. */
function queueVoice(store, guildId, items, nowMs, config) {
  store.updateVoiceQueue(guildId, (queue) => mergeIntoQueue(queue, items, nowMs, config));
  return store.getVoiceQueue(guildId);
}

/** Every queued item of a guild due at `nowMs` (the back-off of the items is the test's to skip). */
function makeVoiceDue(store, guildId, nowMs) {
  store.updateVoiceQueue(guildId, (queue) => queue.map((item) => ({ ...item, nextAt: nowMs })));
}

/** The parsed `<items>` array of a voice request. */
function voiceItemsOf(messages) {
  return JSON.parse(blockBody(messages[1].content, 'items'));
}

/** Whether a request is a stage B one (prompts/memory-voice.md): it carries `<items>`. The role
 * alone does not tell: the single-stage fallback on the voice model goes out as role `voice` too. */
function isVoiceRequest(messages) {
  return blockBody(messages[1]?.content ?? '', 'items') !== null;
}

/**
 * A fake llm. A voice request is answered with `word(item)` for each item it carries (a string
 * words it, anything else leaves it out); any other request gets `decision` (stage A, or the
 * single-stage fallback) as JSON. `before(messages, options)` runs, and is awaited, before either
 * answer: it may throw (a failed request) or change the store (something happening meanwhile).
 */
function voiceLlm({ word = () => null, decision = {}, before } = {}) {
  const calls = [];
  return {
    calls,
    voiceCalls: () => calls.filter((call) => isVoiceRequest(call.messages)),
    complete: async (messages, options) => {
      calls.push({ messages, options });
      if (before) await before(messages, options);
      if (!isVoiceRequest(messages)) return { text: JSON.stringify(decision) };
      const items = {};
      for (const item of voiceItemsOf(messages)) {
        const text = word(item);
        if (typeof text === 'string') items[item.id] = text;
      }
      return { text: JSON.stringify({ items }) };
    },
  };
}

function voiceUpdater(store, hot, llm, now = () => VOICE_AT) {
  return createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now });
}

test('run (two-stage): a voice request follows a successful batch on models.base.voice as a memory-wording request, and its texts are stored', async () => {
  await withStoreAsync(async (store, dir) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now() - 60_000);
    store.pushBuffer(guildId, slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: Date.now() - 1000 }), 100);
    const hot = voiceHot(
      { model: 'openai/gpt-z', batchMessages: 1, minBatchMessages: 1, temperature: 0.4, timeoutMs: 4321, voice: { maxOutputTokens: 2500 } },
      { relationships: { damping: false } },
    );
    const texts = { relationship: 'φίλοι από το παζλ', reason: 'με βοήθησε στο δύσκολο σημείο', feeling: 'χάρηκα πολύ' };
    const llm = voiceLlm({
      decision: { users: { 1: { relationship: 'έγιναν φίλοι', affinity: { delta: 4, event: 'τη βοήθησε' }, episodes: [{ what: 'έλυσαν ένα παζλ', tone: 'χαρά' }] } } },
      word: (item) => texts[item.kind],
    });
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));

    assert.equal(llm.calls.length, 2, 'stage A, then one voice request');
    const [stageA, voice] = llm.calls;
    assert.equal(stageA.options.role, 'extractor');
    assert.equal(stageA.options.model, 'openai/gpt-z');
    assert.equal('purpose' in stageA.options, false, 'stage A is no memory-wording request');
    assert.equal(voice.options.role, 'voice');
    assert.equal(voice.options.purpose, 'memory-voice');
    assert.equal(voice.options.cache, false);
    assert.equal(voice.options.model, undefined, 'models.base.voice');
    assert.equal(voice.options.maxOutputTokens, 2500);
    assert.equal(voice.options.temperature, 0.4);
    assert.equal(voice.options.skipCalibration, false, 'models.base.voice feeds the calibration');
    assert.equal(voice.messages[0].content, 'voice prompt for Nept: relationship 600, portrait 400');
    assert.deepEqual(voiceItemsOf(voice.messages).map((item) => item.kind).sort(), ['feeling', 'reason', 'relationship']);

    const aria = store.getUser(guildId, '1');
    assert.equal(aria.relationship, 'φίλοι από το παζλ');
    assert.equal(aria.relationshipScore, 4, 'stamped with the score stage A already moved');
    assert.equal(aria.affinity.score, 4, 'the score moved once, at stage A');
    assert.equal(aria.affinity.reason, 'με βοήθησε στο δύσκολο σημείο');
    assert.equal(aria.affinity.history.at(-1).reason, 'με βοήθησε στο δύσκολο σημείο');
    assert.equal(aria.episodes[0].feeling, 'χάρηκα πολύ');
    assert.deepEqual(store.getVoiceQueue(guildId), [], 'every applied item left the queue');
    assert.equal(store.state.data.voiceCount, 1, 'the voice request counts, stage A does not');
    assert.equal(store.state.data.voiceDay, utcDay(Date.now()));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'guilds', guildId, 'voice.json'), 'utf8')), [], 'flushed');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'guilds', guildId, 'users', '1.json'), 'utf8'));
    assert.equal(onDisk.relationship, 'φίλοι από το παζλ');

    const applied = logs.find((entry) => entry.msg === 'memory: voice applied');
    assert.deepEqual(
      { guildId: applied.guildId, sent: applied.sent, applied: applied.applied, missing: applied.missing, gone: applied.gone, queued: applied.queued },
      { guildId, sent: 3, applied: 3, missing: 0, gone: 0, queued: 0 },
    );
    assert.deepEqual(applied.byKind, { relationship: 1, reason: 1, feeling: 1 });
    assert.ok(Number.isInteger(applied.outputTokens) && applied.outputTokens > 0 && applied.outputTokens <= 2500, 'the answer budget the request was fitted to');
    assert.ok(!JSON.stringify(logs).includes('παζλ'), 'counts only');
  });
});

test('runVoice: sends on models.base.voice and feeds calibration whatever a stale memory.voiceModel says; models.base.extractor is never used', async () => {
  for (const voiceModel of [undefined, null, 'anthropic/voice-v']) {
    await withStoreAsync(async (store) => {
      store.touchUser('g1', '1', 'Aria', VOICE_AT);
      const hot = voiceHot({ model: 'openai/gpt-z', voiceModel, reasoning: { effort: 'low' } });
      queueVoice(store, 'g1', [{ kind: 'relationship', userId: '1', brief: ['φίλοι'] }], VOICE_AT, hot.config);
      const llm = voiceLlm({ word: () => 'φίλοι' });

      await withCapturedLogs(() => voiceUpdater(store, hot, llm).runVoice('g1'));

      assert.equal(llm.calls.length, 1);
      const [{ options }] = llm.calls;
      assert.equal(options.model, undefined, `voiceModel ${voiceModel}`);
      assert.equal(options.role, 'voice');
      assert.equal(options.purpose, 'memory-voice');
      assert.equal(options.skipCalibration, false, `voiceModel ${voiceModel}`);
      assert.equal('reasoning' in options, false, 'the stage A reasoning setting stays with stage A');
    });
  }
});

test('runVoice: the request takes memory.voice.timeoutMs, read at each run, never the batch\'s memory.timeoutMs', async () => {
  await withStoreAsync(async (store) => {
    store.touchUser('g1', '1', 'Aria', VOICE_AT);
    const hot = voiceHot({ timeoutMs: 900000, voice: { timeoutMs: 45000 } });
    const llm = voiceLlm({ word: () => 'φίλοι' });
    const updater = voiceUpdater(store, hot, llm);

    queueVoice(store, 'g1', [{ kind: 'relationship', userId: '1', brief: ['φίλοι'] }], VOICE_AT, hot.config);
    await withCapturedLogs(() => updater.runVoice('g1'));
    hot.config.memory.voice.timeoutMs = 60000;
    queueVoice(store, 'g1', [{ kind: 'relationship', userId: '1', brief: ['καλοί φίλοι'] }], VOICE_AT, hot.config);
    await withCapturedLogs(() => updater.runVoice('g1'));

    assert.deepEqual(llm.calls.map((call) => call.options.timeoutMs), [45000, 60000]);
  });
});

test('runVoice: an item queued while the request is in flight stays queued; only the applied ids leave the queue', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', VOICE_AT);
    store.touchUser(guildId, '2', 'Βασίλης', VOICE_AT);
    const hot = voiceHot();
    queueVoice(
      store,
      guildId,
      [
        { kind: 'relationship', userId: '1', brief: ['φίλοι'] },
        { kind: 'patterns', brief: ['αστεία το βράδυ'] },
        { kind: 'self', brief: ['της αρέσει ο καφές'] },
      ],
      VOICE_AT - MINUTE_MS,
      hot.config,
    );
    const llm = voiceLlm({
      word: (item) => (item.kind === 'self' ? null : `κείμενο ${item.kind}`),
      // A stage A batch queues meanwhile: a new member's item, and a brief folded into the queued patterns item.
      before: () => queueVoice(store, guildId, [{ kind: 'relationship', userId: '2', brief: ['νέος φίλος'] }, { kind: 'patterns', brief: ['εικόνες τα πρωινά'] }], VOICE_AT, hot.config),
    });

    const { logs } = await withCapturedLogs(() => voiceUpdater(store, hot, llm).runVoice(guildId));

    assert.deepEqual(voiceItemsOf(llm.calls[0].messages).map((item) => item.kind), ['relationship', 'patterns', 'self']);
    const queue = store.getVoiceQueue(guildId);
    assert.deepEqual(queue.map((item) => item.kind).sort(), ['patterns', 'relationship', 'self']);
    assert.equal(store.getUser(guildId, '1').relationship, 'κείμενο relationship', 'the applied item landed and left');
    const added = queue.find((item) => item.kind === 'relationship');
    assert.equal(added.userId, '2', 'the item queued during the request is still there');
    assert.equal(added.attempts, 0, 'untouched');
    const patterns = queue.find((item) => item.kind === 'patterns');
    assert.deepEqual(patterns.brief, ['αστεία το βράδυ', 'εικόνες τα πρωινά'], 'the merged item stays queued');
    assert.equal(store.getGuild(guildId).patterns, '', 'an answer to the brief before the merge never lands on the merged item');
    const self = queue.find((item) => item.kind === 'self');
    assert.equal(self.misses, 1, 'left out of the answer: a miss');
    assert.equal(self.attempts, 1);
    assert.equal(self.nextAt, VOICE_AT + 15 * MINUTE_MS);
    const applied = logs.find((entry) => entry.msg === 'memory: voice applied');
    assert.deepEqual(
      { sent: applied.sent, applied: applied.applied, missing: applied.missing, stale: applied.stale, queued: applied.queued },
      { sent: 3, applied: 1, missing: 1, stale: 1, queued: 3 },
    );
  });
});

test('run (two-stage): a failed voice request keeps the items with a later nextAt, backs the guild off, and the batch stays consumed', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    let clock = VOICE_AT;
    store.touchUser(guildId, '1', 'Aria', clock - MINUTE_MS);
    store.pushBuffer(guildId, slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: clock - 1000 }), 100);
    const hot = voiceHot({ batchMessages: 1, minBatchMessages: 1 });
    const llm = voiceLlm({
      decision: { users: { 1: { relationship: 'έγιναν φίλοι' } } },
      before: (messages) => {
        if (isVoiceRequest(messages)) throw Object.assign(new Error('provider unavailable'), { statusCode: 503 });
      },
    });
    const updater = voiceUpdater(store, hot, llm, () => clock);

    const { logs } = await withCapturedLogs(() => updater.run(guildId));

    assert.equal(llm.voiceCalls().length, 1);
    assert.equal(store.state.data.voiceCount, 1, 'a request that went out counts even when it failed');
    assert.deepEqual(store.getBuffer(guildId), [], 'the batch stays consumed');
    const [item, ...rest] = store.getVoiceQueue(guildId);
    assert.deepEqual(rest, []);
    assert.equal(item.kind, 'relationship');
    assert.equal(item.attempts, 1);
    assert.equal(item.misses, 0, 'a failed request is not a miss');
    assert.equal(item.nextAt, clock + 15 * MINUTE_MS);
    assert.equal(store.getUser(guildId, '1').relationship, '');
    assert.equal(logs.find((entry) => entry.msg === 'memory: update applied').stage, 'two');
    const failed = logs.find((entry) => entry.msg === 'memory: voice failed');
    assert.deepEqual(
      { reason: failed.reason, status: failed.status, sent: failed.sent, queued: failed.queued, backoffMinutes: failed.backoffMinutes },
      { reason: 'llm-error', status: 503, sent: 1, queued: 1, backoffMinutes: 15 },
    );

    // The guild backs off too: an item made due again is not sent before the back-off is over.
    makeVoiceDue(store, guildId, clock);
    clock += 10 * MINUTE_MS;
    await withCapturedLogs(() => updater.tick());
    assert.equal(llm.voiceCalls().length, 1, 'inside the guild back-off');
    clock += 5 * MINUTE_MS;
    await withCapturedLogs(() => updater.tick());
    assert.equal(llm.voiceCalls().length, 2, 'retried once it is over, without a new batch');
  });
});

test('runVoice: the guild back-off doubles with each failed request up to memory.voice.queueHours, a character item is never dropped, and a parsed answer clears it', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    let clock = VOICE_AT;
    store.touchUser(guildId, '1', 'Aria', clock);
    const hot = voiceHot({ voice: { retryMinutes: 10, queueHours: 1 } });
    queueVoice(store, guildId, [{ kind: 'character', userId: '1', brief: { add: ['γράφει σύντομα'] } }], clock, hot.config);
    let failing = true;
    const llm = voiceLlm({
      word: () => 'νέο πορτρέτο',
      before: () => {
        if (failing) throw new Error('down');
      },
    });
    const updater = voiceUpdater(store, hot, llm, () => clock);

    const backoffs = [];
    for (let i = 0; i < 5; i += 1) {
      makeVoiceDue(store, guildId, clock);
      const { logs } = await withCapturedLogs(() => updater.runVoice(guildId));
      const { backoffMinutes } = logs.find((entry) => entry.msg === 'memory: voice failed');
      backoffs.push(backoffMinutes);
      clock += backoffMinutes * MINUTE_MS - 1;
      makeVoiceDue(store, guildId, clock);
      assert.equal((await updater.runVoice(guildId)).reason, 'backoff', `failure ${i + 1}`);
      clock += 1;
    }

    assert.deepEqual(backoffs, [10, 20, 40, 60, 60], 'doubling from retryMinutes, never longer than queueHours');
    assert.equal(llm.calls.length, 5, 'one request per back-off');
    assert.equal(store.getVoiceQueue(guildId).length, 1, 'past queueHours and every retry, the character item is still queued');
    failing = false;
    makeVoiceDue(store, guildId, clock);
    await withCapturedLogs(() => updater.runVoice(guildId));
    assert.equal(store.getUser(guildId, '1').character, 'νέο πορτρέτο');

    // The next outage starts again from retryMinutes: the parsed answer cleared the failures in a row.
    failing = true;
    queueVoice(store, guildId, [{ kind: 'self', brief: ['της αρέσει η βροχή'] }], clock, hot.config);
    const { logs } = await withCapturedLogs(() => updater.runVoice(guildId));
    assert.equal(llm.calls.length, 7, 'sent at once: no back-off left after a parsed answer');
    assert.equal(logs.find((entry) => entry.msg === 'memory: voice failed').backoffMinutes, 10, 'counted from memory.voice.retryMinutes again');
  });
});

test('tick: while the guild backs off, an item past memory.voice.queueHours still takes the degraded path on time, and nothing is sent', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    let clock = VOICE_AT;
    const hot = voiceHot({ voice: { retryMinutes: 30, queueHours: 1 } });
    queueVoice(store, guildId, [{ kind: 'self', brief: ['της αρέσει η βροχή'] }], clock, hot.config);
    const llm = voiceLlm({
      before: () => {
        throw new Error('down');
      },
    });
    const updater = voiceUpdater(store, hot, llm, () => clock);

    await withCapturedLogs(() => updater.runVoice(guildId)); // the guild backs off 30 minutes
    clock += 30 * MINUTE_MS;
    await withCapturedLogs(() => updater.runVoice(guildId)); // and now 60
    assert.equal(llm.calls.length, 2);
    clock += 31 * MINUTE_MS;
    const { logs } = await withCapturedLogs(() => updater.tick());

    assert.equal(llm.calls.length, 2, 'nothing sent while backed off');
    assert.deepEqual(store.getGuild(guildId).self, ['της αρέσει η βροχή'], 'the expired self fact is stored from its brief');
    assert.deepEqual(store.getVoiceQueue(guildId), []);
    assert.equal(logs.find((entry) => entry.msg === 'memory: voice dropped').expired, 1);
  });
});

test('tick: a queued item past nextAt is retried without a new batch, and not before', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    let clock = VOICE_AT;
    store.touchUser(guildId, '1', 'Aria', clock);
    const hot = voiceHot();
    queueVoice(store, guildId, [{ kind: 'relationship', userId: '1', brief: ['φίλοι'] }], clock, hot.config);
    store.updateVoiceQueue(guildId, (queue) => retryLater(queue, queue.map((item) => item.id), clock, hot.config));
    const llm = voiceLlm({ word: () => 'φίλοι πια' });
    const updater = voiceUpdater(store, hot, llm, () => clock);

    await withCapturedLogs(() => updater.tick());
    assert.equal(llm.calls.length, 0, 'not due yet');
    clock += 15 * MINUTE_MS;
    await withCapturedLogs(() => updater.tick());

    assert.equal(llm.calls.length, 1);
    assert.equal(llm.calls[0].options.role, 'voice');
    assert.equal(store.getUser(guildId, '1').relationship, 'φίλοι πια');
    assert.deepEqual(store.getVoiceQueue(guildId), []);
  });
});

test('runVoice: one request per run with at most memory.voice.maxItems items; the rest wait for the next run', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = voiceHot({ voice: { maxItems: 2 } });
    const claims = ['αγαπά τη βροχή', 'μισεί το κρύο', 'μαζεύει πέτρες', 'διαβάζει ποίηση', 'πίνει τσάι'];
    queueVoice(store, guildId, claims.map((claim) => ({ kind: 'self', brief: [claim] })), VOICE_AT, hot.config);
    const llm = voiceLlm({ word: (item) => item.brief[0] });
    const updater = voiceUpdater(store, hot, llm);

    await withCapturedLogs(() => updater.runVoice(guildId));
    assert.equal(llm.calls.length, 1);
    assert.equal(voiceItemsOf(llm.calls[0].messages).length, 2);
    assert.equal(store.getVoiceQueue(guildId).length, 3);

    await withCapturedLogs(() => updater.runVoice(guildId));
    assert.equal(llm.calls.length, 2);
    assert.deepEqual(store.getGuild(guildId).self, claims.slice(0, 4), 'oldest first');
  });
});

test('runVoice: memory.voice.maxPerDay reached sends nothing and logs memory: voice skipped once an hour; 0, a missing key or a non-number never sends', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    let clock = VOICE_AT;
    store.touchUser(guildId, '1', 'Aria', clock);
    const hot = voiceHot({ voice: { maxPerDay: 1 } });
    // Every answer leaves the item out: it stays queued (a character item never expires).
    const llm = voiceLlm({ word: () => null });
    const updater = voiceUpdater(store, hot, llm, () => clock);
    queueVoice(store, guildId, [{ kind: 'character', userId: '1', brief: { add: ['γράφει σύντομα'] } }], clock, hot.config);

    await withCapturedLogs(() => updater.runVoice(guildId));
    assert.equal(llm.calls.length, 1);
    assert.equal(store.state.data.voiceCount, 1);

    const { result: capped, logs } = await withCapturedLogs(async () => {
      makeVoiceDue(store, guildId, clock);
      const first = await updater.runVoice(guildId);
      clock += 30 * MINUTE_MS;
      makeVoiceDue(store, guildId, clock);
      await updater.runVoice(guildId);
      clock += 31 * MINUTE_MS;
      makeVoiceDue(store, guildId, clock);
      await updater.runVoice(guildId);
      return first;
    });
    assert.equal(capped.reason, 'daily-cap');
    assert.equal(llm.calls.length, 1, 'nothing sent past the cap');
    const skipped = logs.filter((entry) => entry.msg === 'memory: voice skipped');
    assert.equal(skipped.length, 2, 'at most once an hour');
    assert.deepEqual({ guildId: skipped[0].guildId, reason: skipped[0].reason }, { guildId, reason: 'daily-cap' });

    clock = VOICE_AT + DAY_MS;
    makeVoiceDue(store, guildId, clock);
    await withCapturedLogs(() => updater.runVoice(guildId));
    assert.equal(llm.calls.length, 2, 'the next UTC day counts from zero');

    for (const maxPerDay of [0, undefined, '100']) {
      hot.config.memory.voice = { maxPerDay };
      clock += DAY_MS;
      makeVoiceDue(store, guildId, clock);
      const { result } = await withCapturedLogs(() => updater.runVoice(guildId));
      assert.equal(result.reason, 'daily-cap', `maxPerDay ${JSON.stringify(maxPerDay)}`);
    }
    assert.equal(llm.calls.length, 2, 'never sent');
  });
});

test('runVoice: a request the llm refuses before sending gives the voice count back and backs off', async () => {
  const refusals = [
    [new DailyCapError('daily LLM request cap reached'), 'daily-cap'],
    [new TokenLimitError('request estimated over the cap'), 'token-limit'],
  ];
  for (const [error, reason] of refusals) {
    await withStoreAsync(async (store) => {
      const guildId = 'g1';
      store.touchUser(guildId, '1', 'Aria', VOICE_AT);
      const hot = voiceHot();
      queueVoice(store, guildId, [{ kind: 'relationship', userId: '1', brief: ['φίλοι'] }], VOICE_AT, hot.config);
      const llm = voiceLlm({
        before: () => {
          throw error;
        },
      });
      const updater = voiceUpdater(store, hot, llm);

      const { result, logs } = await withCapturedLogs(() => updater.runVoice(guildId));

      assert.equal(result.reason, reason);
      assert.equal(store.state.data.voiceCount, 0, 'nothing was sent: the count is given back');
      assert.equal(logs.find((entry) => entry.msg === 'memory: voice failed').reason, reason);
      assert.equal(store.getVoiceQueue(guildId)[0].misses, 0);
      assert.equal((await updater.runVoice(guildId)).reason, 'backoff');
    });
  }
});

test('runVoice: an answer without an items object is bad-json and a cut one truncated: every sent item backs off, none counts a miss', async () => {
  const answers = [
    ['καμία απάντηση', 'stop', 'bad-json'],
    ['{"items": {"1": "μισή', 'length', 'truncated'],
    ['{"texts": {"1": "λάθος κλειδί"}}', 'stop', 'bad-json'],
  ];
  for (const [text, finishReason, reason] of answers) {
    await withStoreAsync(async (store) => {
      const guildId = 'g1';
      store.touchUser(guildId, '1', 'Aria', VOICE_AT);
      const hot = voiceHot();
      queueVoice(store, guildId, [{ kind: 'relationship', userId: '1', brief: ['φίλοι'] }, { kind: 'self', brief: ['της αρέσει ο καφές'] }], VOICE_AT, hot.config);
      const llm = { complete: async () => ({ text, finishReason }) };

      const { result, logs } = await withCapturedLogs(() => voiceUpdater(store, hot, llm).runVoice(guildId));

      assert.equal(result.reason, reason, text);
      assert.equal(store.state.data.voiceCount, 1, 'billed: the request counts');
      assert.ok(store.getVoiceQueue(guildId).every((item) => item.attempts === 1 && item.misses === 0 && item.nextAt === VOICE_AT + 15 * MINUTE_MS));
      const failed = logs.find((entry) => entry.msg === 'memory: voice failed');
      assert.equal(failed.reason, reason);
      assert.equal(failed.sent, 2);
      for (const word of ['απάντηση', 'μισή', 'κλειδί']) assert.ok(!JSON.stringify(logs).includes(word), 'never the answer');
    });
  }
});

test('runVoice: items older than memory.voice.queueHours take the degraded path before the request; a character item stays and is sent', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const old = VOICE_AT - 25 * HOUR_MS;
    store.touchUser(guildId, '1', 'Aria', old);
    store.addEpisodes(guildId, '1', [{ date: '2026-01-09', what: 'γέλασαν με την πάπια', feeling: '' }], { maxEpisodes: 20, now: old });
    const hot = voiceHot();
    queueVoice(
      store,
      guildId,
      [
        { kind: 'feeling', userId: '1', brief: ['ήσυχη χαρά'], payload: { at: new Date(old).toISOString(), date: '2026-01-09', what: 'γέλασαν με την πάπια', quote: '' } },
        { kind: 'relationship', userId: '1', brief: ['φίλοι'] },
        { kind: 'character', userId: '1', brief: { add: ['γράφει σύντομα'] } },
      ],
      old,
      hot.config,
    );
    const llm = voiceLlm({ word: (item) => (item.kind === 'character' ? 'νέο πορτρέτο' : 'αργά πια') });

    const { logs } = await withCapturedLogs(() => voiceUpdater(store, hot, llm).runVoice(guildId));

    assert.deepEqual(voiceItemsOf(llm.calls[0].messages).map((item) => item.kind), ['character'], 'only the character item is still sent');
    const aria = store.getUser(guildId, '1');
    assert.equal(aria.episodes[0].feeling, 'ήσυχη χαρά', 'an expired feeling keeps the stage A tone');
    assert.equal(aria.relationship, '', 'an expired relationship is dropped');
    assert.equal(aria.character, 'νέο πορτρέτο');
    assert.deepEqual(store.getVoiceQueue(guildId), []);
    const dropped = logs.find((entry) => entry.msg === 'memory: voice dropped');
    assert.deepEqual(
      { guildId: dropped.guildId, expired: dropped.expired, overflow: dropped.overflow, degraded: dropped.degraded },
      { guildId, expired: 2, overflow: 0, degraded: 1 },
    );
    assert.ok(!JSON.stringify(logs).includes('χαρά'), 'counts only');
  });
});

test('runVoice: a character item rewrites the portrait only, and the portrait stamps are written when it is applied, never before', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    let clock = VOICE_AT;
    store.touchUser(guildId, ZOE, 'Zoé', clock - DAY_MS);
    store.applyProfileOps(guildId, ZOE, { character: 'παλιό πορτρέτο', style: 'σύντομες φράσεις', relationship: 'φίλοι' }, { fieldChars: 400 });
    store.updateUser(guildId, ZOE, { messageCount: 420, portraitAttemptAt: new Date(clock - HOUR_MS).toISOString() });
    const hot = voiceHot();
    const queuedAt = clock - 2 * HOUR_MS;
    queueVoice(store, guildId, [{ kind: 'character', userId: ZOE, brief: { keep: ['μιλάει πολύ'], add: ['γράφει σύντομα'] } }], queuedAt, hot.config);
    let failing = true;
    const llm = voiceLlm({
      word: () => 'συγχωνευμένο πορτρέτο',
      before: () => {
        if (failing) throw new Error('down');
      },
    });
    const updater = voiceUpdater(store, hot, llm, () => clock);

    await withCapturedLogs(() => updater.runVoice(guildId));

    const [view] = voiceItemsOf(llm.calls[0].messages);
    assert.equal(view.member, `Zoé (id:${ZOE})`);
    assert.equal(view.old, 'παλιό πορτρέτο', 'the stored portrait goes in as the base');
    assert.deepEqual(view.brief, { keep: ['μιλάει πολύ'], add: ['γράφει σύντομα'] });
    let zoe = store.getUser(guildId, ZOE);
    assert.equal(zoe.character, 'παλιό πορτρέτο');
    assert.equal(zoe.portraitRefreshedAt, undefined, 'no stamp while the item waits');
    assert.equal(zoe.portraitMessageCount, undefined);
    assert.equal(store.getVoiceQueue(guildId).length, 1, 'a failed character item stays queued');

    failing = false;
    clock += DAY_MS;
    store.updateUser(guildId, ZOE, { messageCount: 450 });
    const { logs } = await withCapturedLogs(() => updater.runVoice(guildId));

    zoe = store.getUser(guildId, ZOE);
    assert.equal(zoe.character, 'συγχωνευμένο πορτρέτο');
    assert.equal(zoe.style, 'σύντομες φράσεις', 'style untouched');
    assert.equal(zoe.relationship, 'φίλοι', 'relationship untouched');
    assert.equal(zoe.portraitRefreshedAt, new Date(queuedAt).toISOString(), 'dated when the refresh queued it');
    assert.equal(zoe.portraitMessageCount, 450, 'the count when it was applied');
    assert.equal(zoe.portraitAttemptAt, null);
    assert.deepEqual(store.getVoiceQueue(guildId), []);
    assert.equal(logs.find((entry) => entry.msg === 'memory: voice applied').portraits, 1);
  });
});

test('runVoice: paused, nothing is sent; paused while the request is in flight, nothing is written', async () => {
  /** A store with two queued items; `pauseDuring` (given the store) answers the voice request. */
  const pausedRun = (pausedBefore, pauseDuring) =>
    withStoreAsync(async (store) => {
      const guildId = 'g1';
      store.touchUser(guildId, '1', 'Aria', VOICE_AT);
      const hot = voiceHot();
      queueVoice(store, guildId, [{ kind: 'relationship', userId: '1', brief: ['φίλοι'] }, { kind: 'self', brief: ['της αρέσει ο καφές'] }], VOICE_AT, hot.config);
      const before = store.getVoiceQueue(guildId);
      store.state.data.paused = pausedBefore;
      const llm = pauseDuring(store);
      const updater = voiceUpdater(store, hot, llm);

      const { result, logs } = await withCapturedLogs(() => updater.runVoice(guildId));

      assert.equal(result.reason, 'paused');
      assert.equal(store.getUser(guildId, '1').relationship, '', 'nothing applied');
      assert.deepEqual(store.getGuild(guildId).self, []);
      assert.deepEqual(store.getVoiceQueue(guildId), before, 'no item removed or backed off');
      store.state.data.paused = false;
      assert.notEqual((await withCapturedLogs(() => updater.runVoice(guildId))).result.reason, 'backoff', 'no guild back-off either');
      return { calls: llm.calls.length, logs };
    });

  const idle = await pausedRun(true, () => voiceLlm({ word: () => 'κείμενο' }));
  assert.equal(idle.calls, 1, 'nothing sent while paused (the one call is the run after resuming)');
  assert.equal(idle.logs.find((entry) => entry.msg === 'memory: voice skipped').reason, 'paused');

  const answered = await pausedRun(false, (store) =>
    voiceLlm({
      word: (item) => (item.kind === 'self' ? null : 'κείμενο'),
      before: () => {
        store.state.data.paused = true;
      },
    }),
  );
  assert.equal(answered.calls, 2, 'the paused answer, then the run after resuming');
  const discarded = answered.logs.find((entry) => entry.msg === 'memory: voice skipped');
  assert.deepEqual({ reason: discarded.reason, sent: discarded.sent }, { reason: 'paused', sent: 2 });

  const failed = await pausedRun(false, (store) =>
    voiceLlm({
      before: () => {
        if (store.state.data.paused) return;
        store.state.data.paused = true;
        throw new Error('down');
      },
    }),
  );
  assert.equal(failed.calls, 2);
  assert.equal(failed.logs.some((entry) => entry.msg === 'memory: voice failed'), false, 'a failure while paused writes no back-off');
});

/**
 * A store with Aria's stored relationship and two queued items (her relationship, a self fact),
 * and a voice llm whose first answer words the relationship `first` (over 600) and whose second
 * words it with `retry(text)` (null = left out); the self fact is worded on both.
 */
async function overLimitRun({ first, retry, memory = {} }) {
  let outcome;
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', VOICE_AT);
    store.applyProfileOps(guildId, '1', { relationship: 'παλιό κείμενο' }, { relationshipChars: 600 });
    const hot = voiceHot(memory);
    queueVoice(store, guildId, [{ kind: 'relationship', userId: '1', brief: ['φίλοι'] }, { kind: 'self', brief: ['της αρέσει ο καφές'] }], VOICE_AT, hot.config);
    const llm = voiceLlm({
      word: (item) => {
        const call = llm.voiceCalls().length;
        if (item.kind === 'self') return call === 1 ? 'μου αρέσει ο καφές' : 'κάτι άλλο';
        return call === 1 ? first : retry;
      },
    });
    const { result, logs } = await withCapturedLogs(() => voiceUpdater(store, hot, llm).runVoice(guildId));
    outcome = {
      result,
      calls: llm.voiceCalls(),
      applied: logs.find((entry) => entry.msg === 'memory: voice applied'),
      relationship: store.getUser(guildId, '1').relationship,
      self: store.getGuild(guildId).self,
      versions: store.listVersions(guildId, 'users', '1').relationship ?? [],
      queue: store.getVoiceQueue(guildId),
      voiceCount: store.state.data.voiceCount,
      logs,
    };
  });
  return outcome;
}

/** The parsed `<over_limit>` block of a retry's last message. */
function overLimitOfRetry(messages) {
  return JSON.parse(blockBody(messages.at(-1).content, 'over_limit'));
}

test('runVoice: a rewrite over its limit is asked once more as a dialogue and the shorter answer is stored by voice', async () => {
  const long = 'ά'.repeat(700);
  const run = await overLimitRun({ first: long, retry: 'σύντομο νέο κείμενο' });
  assert.equal(run.calls.length, 2, 'the first request, then one retry');
  const [firstCall, retryCall] = run.calls;
  assert.equal(firstCall.messages.length, 2);
  assert.ok(!firstCall.messages.some((message) => message.content.includes('<over_limit>')), 'the first request has no <over_limit>');
  assert.equal(retryCall.messages.length, 4);
  assert.deepEqual(retryCall.messages.slice(0, 2), firstCall.messages, 'the first request, unchanged');
  const relationshipId = voiceItemsOf(firstCall.messages).find((item) => item.kind === 'relationship').id;
  const selfId = voiceItemsOf(firstCall.messages).find((item) => item.kind === 'self').id;
  assert.deepEqual(retryCall.messages[2], { role: 'assistant', content: JSON.stringify({ items: { [relationshipId]: long, [selfId]: 'μου αρέσει ο καφές' } }) });
  assert.equal(retryCall.messages[3].role, 'user');
  assert.deepEqual(overLimitOfRetry(retryCall.messages), { [relationshipId]: { chars: 700, limit: 600 } }, 'only the over item');
  assert.deepEqual(retryCall.options, firstCall.options, 'the same role and purpose');

  assert.equal(run.relationship, 'σύντομο νέο κείμενο');
  assert.deepEqual(run.self, ['μου αρέσει ο καφές'], 'the item applied by the first answer is not written again');
  assert.equal(run.versions.length, 1);
  assert.deepEqual([run.versions[0].by, run.versions[0].text], ['voice', 'παλιό κείμενο']);
  assert.deepEqual(run.queue, []);
  assert.equal(run.voiceCount, 2, 'the retry counts against memory.voice.maxPerDay');
  assert.deepEqual(
    { sent: run.applied.sent, applied: run.applied.applied, missing: run.applied.missing, overLimit: run.applied.overLimit, overLimitRetried: run.applied.overLimitRetried },
    { sent: 2, applied: 2, missing: 0, overLimit: 0, overLimitRetried: 1 },
  );
  assert.deepEqual(run.applied.byKind, { self: 1, relationship: 1 });
  assert.deepEqual(run.result, { sent: 2, applied: 2 });
});

test('runVoice: a retry still over the limit, or without the item, keeps the stored text and drops the item as over-limit', async () => {
  for (const retry of ['έ'.repeat(650), null]) {
    const run = await overLimitRun({ first: 'ά'.repeat(700), retry });
    assert.equal(run.calls.length, 2, `retry ${retry === null ? 'missing' : 'over'}`);
    assert.equal(run.relationship, 'παλιό κείμενο', 'the stored text stays');
    assert.deepEqual(run.versions, [], 'nothing changed, nothing recorded');
    assert.deepEqual(run.queue, [], 'never queued again');
    assert.deepEqual(run.self, ['μου αρέσει ο καφές']);
    assert.deepEqual(
      { applied: run.applied.applied, missing: run.applied.missing, overLimit: run.applied.overLimit, overLimitRetried: run.applied.overLimitRetried },
      { applied: 1, missing: 0, overLimit: 1, overLimitRetried: 1 },
    );
    assert.ok(!JSON.stringify(run.logs).includes('έέέ'), 'counts only');
  }
});

test('runVoice: memory.overLimitRetries 0 sends no retry; the over item leaves the queue at once', async () => {
  const run = await overLimitRun({ first: 'ά'.repeat(700), retry: 'σύντομο', memory: { overLimitRetries: 0 } });
  assert.equal(run.calls.length, 1);
  assert.equal(run.relationship, 'παλιό κείμενο');
  assert.deepEqual(run.queue, []);
  assert.deepEqual({ overLimit: run.applied.overLimit, overLimitRetried: run.applied.overLimitRetried }, { overLimit: 1, overLimitRetried: 0 });
});

test('waitIdle: waits for a voice request in flight, and its texts land before it resolves', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', VOICE_AT);
    const hot = voiceHot();
    queueVoice(store, guildId, [{ kind: 'relationship', userId: '1', brief: ['φίλοι'] }], VOICE_AT, hot.config);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const llm = voiceLlm({ word: () => 'φίλοι', before: () => gate });
    const updater = voiceUpdater(store, hot, llm);

    const voice = withCapturedLogs(() => updater.runVoice(guildId));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(llm.calls.length, 1, 'in flight');
    let landed = null;
    const waiting = updater.waitIdle().then(() => {
      landed = store.getUser(guildId, '1').relationship;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(landed, null, 'still waiting');

    release();
    await voice;
    await waiting;
    assert.equal(landed, 'φίλοι');
  });
});

test('runVoice: with features.memoryTwoStage off, or the memory-voice prompt missing, no stage B request is ever made', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now() - 60_000);
    const hot = voiceHot({ batchMessages: 1, minBatchMessages: 1 });
    queueVoice(store, guildId, [{ kind: 'relationship', userId: '1', brief: ['φίλοι'] }], Date.now() - HOUR_MS, hot.config);
    const llm = voiceLlm({ word: () => 'φίλοι', decision: { users: { 1: { interests: { add: [{ topic: 'σκάκι', note: '' }] } } } } });
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    hot.config.features.memoryTwoStage = false;
    assert.equal((await updater.runVoice(guildId)).reason, 'off');
    store.pushBuffer(guildId, slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: Date.now() - 1000 }), 100);
    await withCapturedLogs(() => updater.tick());
    assert.equal(llm.calls.length, 1, 'the single-stage batch ran');
    assert.equal(llm.calls[0].options.role, 'extractor', 'with the switch off, on models.base.extractor as before');
    assert.equal(llm.voiceCalls().length, 0, 'no voice request after it, nor from the tick');
    assert.equal(store.state.data.voiceCount, undefined, 'nothing counted on the voice rail');

    hot.config.features.memoryTwoStage = true;
    delete hot.prompts['memory-voice'];
    store.pushBuffer(guildId, slimMessage({ id: 'm2', authorId: '1', authorName: 'Aria', ts: Date.now() - 1000 }), 100);
    const { logs } = await withCapturedLogs(async () => {
      await updater.runVoice(guildId);
      await updater.tick();
      await updater.runVoice(guildId);
    });
    assert.equal(llm.voiceCalls().length, 0);
    assert.equal(llm.calls.length, 2, 'only the batch, on the single-stage fallback');
    assert.equal(llm.calls[1].messages[0].content, 'memory system prompt', 'not a stage B request');
    assert.equal(llm.calls[1].options.role, 'voice', 'the fallback goes out on the voice model as role voice');
    assert.equal(store.state.data.voiceCount, 1, 'and counts on the voice rail');
    const warned = logs.filter((entry) => entry.msg === 'memory: voice skipped');
    assert.equal(warned.length, 1, 'warned once');
    assert.deepEqual({ level: warned[0].level, reason: warned[0].reason }, { level: 'warn', reason: 'no-prompt' });
    assert.equal(store.getVoiceQueue(guildId).length, 1, 'the queue is left alone');

    hot.prompts['memory-voice'] = VOICE_PROMPT;
    await withCapturedLogs(() => updater.tick());
    assert.equal(llm.voiceCalls().length, 1, 'back with the prompt');
    assert.equal(store.getUser(guildId, '1').relationship, 'φίλοι');
  });
});

test('runVoice: private items go in a request of their own and their texts land in the private layer only', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    seedPrivate(store, guildId);
    store.applyProfileOps(guildId, 'u1', { relationship: 'δημόσια γνωριμία' }, { fieldChars: 400 });
    store.applyPrivateOps(guildId, 'u1', { relationship: 'ιδιωτική φιλία' }, { fieldChars: 400 });
    const hot = voiceHot();
    queueVoice(store, guildId, [{ kind: 'relationship', userId: 'u1', brief: ['μιλούν πιο συχνά'] }], VOICE_AT - MINUTE_MS, hot.config);
    queueVoice(store, guildId, [{ kind: 'relationship', userId: 'u1', layer: 'private', brief: ['της είπε ένα μυστικό'] }], VOICE_AT, hot.config);
    const llm = voiceLlm({ word: (item) => (item.layer === 'private' ? 'μοιράζονται μυστικά' : 'γνωστοί από το κανάλι') });
    const updater = voiceUpdater(store, hot, llm);

    await withCapturedLogs(async () => {
      await updater.runVoice(guildId);
      await updater.runVoice(guildId);
    });

    assert.equal(llm.calls.length, 2, 'one request per audience');
    const [publicItems, privateItems] = llm.calls.map((call) => voiceItemsOf(call.messages));
    assert.deepEqual(publicItems.map((item) => [item.kind, item.layer, item.old]), [['relationship', undefined, 'δημόσια γνωριμία']]);
    assert.deepEqual(privateItems.map((item) => [item.kind, item.layer, item.old]), [['relationship', 'private', 'ιδιωτική φιλία']]);
    assert.ok(!llm.calls[0].messages[1].content.includes('μυστικό'), 'nothing said in private sits beside the public items');
    assert.equal(store.getUser(guildId, 'u1').relationship, 'γνωστοί από το κανάλι');
    const priv = store.getPrivate(guildId, 'u1');
    assert.equal(priv.relationship, 'μοιράζονται μυστικά');
    assert.equal(priv.relationshipScore, 14, 'stamped with the effective score: public 10 + private 4');
    assert.deepEqual(store.getVoiceQueue(guildId), []);
  });
});

test('runVoice: every write runs through its store method by kind; an item of a member without a profile leaves the queue as gone', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const at = new Date(VOICE_AT - HOUR_MS).toISOString();
    store.touchUser(guildId, '1', 'Aria', VOICE_AT - DAY_MS);
    store.touchUser(guildId, ZOE, 'Zoé', VOICE_AT - DAY_MS);
    store.adjustAffinity(guildId, '1', 5, 'παλιός λόγος', { maxDelta: 15, historySize: 10, damping: false, now: VOICE_AT - HOUR_MS });
    store.updateGuild(guildId, { patterns: 'παλιά μοτίβα', starters: 'παλιές αρχές' });
    const hot = voiceHot();
    queueVoice(
      store,
      guildId,
      [
        { kind: 'reason', userId: '1', brief: ['τη βοήθησε'], payload: { delta: 5, at } },
        { kind: 'learned', brief: ['γκγκ σημαίνει καληνύχτα'], payload: { from: `<@${ZOE}>`, sure: false, seenAt: VOICE_AT - HOUR_MS } },
        { kind: 'self', brief: ['της αρέσει η βροχή'] },
        { kind: 'patterns', brief: ['αστεία το βράδυ'] },
        { kind: 'starters', brief: ['ερωτήσεις για παιχνίδια'] },
        { kind: 'relationship', userId: '9', brief: ['άγνωστος'] },
      ],
      VOICE_AT - MINUTE_MS,
      hot.config,
    );
    const texts = {
      reason: `με βοήθησε, όπως και η Zoé (id:${ZOE})`,
      learned: 'γκγκ θα πει καληνύχτα',
      self: 'μου αρέσει η βροχή',
      patterns: 'αστεία κυρίως το βράδυ',
      starters: 'ξεκινούν με ερωτήσεις για παιχνίδια',
      relationship: 'κάτι',
    };
    const llm = voiceLlm({ word: (item) => texts[item.kind] });

    const { logs } = await withCapturedLogs(() => voiceUpdater(store, hot, llm).runVoice(guildId));

    const aria = store.getUser(guildId, '1');
    assert.equal(aria.affinity.score, 5, 'the score never moves at stage B');
    assert.equal(aria.affinity.reason, `με βοήθησε, όπως και η <@${ZOE}>`, 'tokenized');
    const guild = store.getGuild(guildId);
    assert.equal(guild.learned.length, 1);
    assert.equal(guild.learned[0].text, 'γκγκ θα πει καληνύχτα');
    assert.equal(guild.learned[0].from, `<@${ZOE}>`);
    assert.equal(guild.learned[0].weight, 0, 'sure: false');
    assert.equal(guild.learned[0].firstSeen, new Date(VOICE_AT - HOUR_MS).toISOString(), 'dated when it was taught');
    assert.deepEqual(guild.self, ['μου αρέσει η βροχή']);
    assert.equal(guild.patterns, 'αστεία κυρίως το βράδυ');
    assert.equal(guild.starters, 'ξεκινούν με ερωτήσεις για παιχνίδια');
    assert.equal(store.getUser(guildId, '9'), null, 'no profile is created for the gone member');
    assert.deepEqual(store.getVoiceQueue(guildId), []);
    const applied = logs.find((entry) => entry.msg === 'memory: voice applied');
    assert.deepEqual({ applied: applied.applied, gone: applied.gone, landed: applied.landed }, { applied: 5, gone: 1, landed: 5 });
  });
});

test('tick: with features.memoryTwoStage off, or the memory-voice prompt missing, items past memory.voice.queueHours still take the degraded path, and nothing is sent', async () => {
  for (const variant of ['off', 'no-prompt']) {
    await withStoreAsync(async (store, dir) => {
      const guildId = 'g1';
      const old = VOICE_AT - 25 * HOUR_MS;
      store.touchUser(guildId, '1', 'Aria', old);
      store.addEpisodes(guildId, '1', [{ date: '2026-01-09', what: 'γέλασαν με την πάπια', feeling: '' }], { maxEpisodes: 20, now: old });
      const hot = voiceHot();
      queueVoice(
        store,
        guildId,
        [
          { kind: 'feeling', userId: '1', brief: ['ήσυχη χαρά'], payload: { at: new Date(old).toISOString(), date: '2026-01-09', what: 'γέλασαν με την πάπια', quote: '' } },
          { kind: 'self', brief: ['της αρέσει η βροχή'] },
          { kind: 'character', userId: '1', brief: { add: ['γράφει σύντομα'] } },
        ],
        old,
        hot.config,
      );
      if (variant === 'off') hot.config.features.memoryTwoStage = false; // a rollback
      else delete hot.prompts['memory-voice'];
      const llm = voiceLlm({ word: () => 'κείμενο' });
      const updater = voiceUpdater(store, hot, llm);

      const { logs } = await withCapturedLogs(() => updater.tick());

      assert.equal(llm.calls.length, 0, `${variant}: nothing sent`);
      assert.equal(store.state.data.voiceCount, undefined, `${variant}: nothing counted on the voice rail`);
      assert.equal(store.getUser(guildId, '1').episodes[0].feeling, 'ήσυχη χαρά', `${variant}: the feeling keeps the stage A tone`);
      assert.deepEqual(store.getGuild(guildId).self, ['της αρέσει η βροχή'], `${variant}: the self fact is stored from its brief`);
      assert.deepEqual(store.getVoiceQueue(guildId).map((item) => item.kind), ['character'], `${variant}: a character item is never dropped`);
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'guilds', guildId, 'voice.json'), 'utf8'));
      assert.deepEqual(onDisk.map((item) => item.kind), ['character'], `${variant}: flushed`);
      const dropped = logs.find((entry) => entry.msg === 'memory: voice dropped');
      assert.deepEqual({ guildId: dropped.guildId, expired: dropped.expired, degraded: dropped.degraded }, { guildId, expired: 2, degraded: 2 }, variant);
      assert.ok(!JSON.stringify(logs).includes('χαρά'), 'counts only');
    });
  }
});

test('runVoice: a second run while one is in flight is busy and the tick starts none beside it; one request, each text written once', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', VOICE_AT);
    const hot = voiceHot();
    queueVoice(store, guildId, [{ kind: 'relationship', userId: '1', brief: ['φίλοι'] }, { kind: 'self', brief: ['της αρέσει ο καφές'] }], VOICE_AT - MINUTE_MS, hot.config);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const llm = voiceLlm({ word: (item) => `κείμενο ${item.kind}`, before: () => gate });
    const updater = voiceUpdater(store, hot, llm);

    const { result, logs } = await withCapturedLogs(async () => {
      const first = updater.runVoice(guildId);
      await new Promise((resolve) => setImmediate(resolve));
      const second = updater.runVoice(guildId);
      const ticked = updater.tick();
      await new Promise((resolve) => setImmediate(resolve));
      const inFlight = llm.calls.length;
      release();
      await ticked;
      return { first: await first, second: await second, inFlight };
    });

    assert.equal(result.second.reason, 'busy');
    assert.equal(result.inFlight, 1, 'neither the second run nor the tick sent anything beside the first');
    assert.deepEqual(result.first, { sent: 2, applied: 2 });
    assert.equal(llm.calls.length, 1);
    assert.equal(logs.filter((entry) => entry.msg === 'memory: voice applied').length, 1, 'applied once');
    assert.equal(store.state.data.voiceCount, 1);
    assert.equal(store.getUser(guildId, '1').relationship, 'κείμενο relationship');
    assert.deepEqual(store.getGuild(guildId).self, ['κείμενο self']);
    assert.deepEqual(store.getVoiceQueue(guildId), []);
  });
});

test('tick: no voice run starts beside a batch in flight for the guild; the batch runs one request that carries the queued and the new items', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const clock = VOICE_AT;
    store.touchUser(guildId, '1', 'Aria', clock - MINUTE_MS);
    store.pushBuffer(guildId, slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: clock - 1000 }), 100);
    const hot = voiceHot({ batchMessages: 1, minBatchMessages: 1 });
    queueVoice(store, guildId, [{ kind: 'self', brief: ['της αρέσει η βροχή'] }], clock - MINUTE_MS, hot.config);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const llm = voiceLlm({
      decision: { users: { 1: { relationship: 'έγιναν φίλοι' } } },
      word: (item) => `κείμενο ${item.kind}`,
      // Only stage A is held: a voice request started beside it would go out at once.
      before: (messages) => (isVoiceRequest(messages) ? undefined : gate),
    });
    const updater = voiceUpdater(store, hot, llm, () => clock);

    await withCapturedLogs(async () => {
      const first = updater.tick();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(llm.calls.length, 1, 'only the stage A request is in flight');
      await updater.tick();
      assert.equal(llm.calls.length, 1, 'a second tick starts nothing beside the batch either');
      release();
      await first;
    });

    const voiceCalls = llm.voiceCalls();
    assert.equal(voiceCalls.length, 1, 'one voice request, after the batch');
    assert.deepEqual(voiceItemsOf(voiceCalls[0].messages).map((item) => item.kind).sort(), ['relationship', 'self']);
    assert.equal(store.getUser(guildId, '1').relationship, 'κείμενο relationship');
    assert.deepEqual(store.getGuild(guildId).self, ['κείμενο self']);
    assert.deepEqual(store.getVoiceQueue(guildId), []);
  });
});

test('runVoice: a request that cannot fit llm.maxRequestTokens sends and counts nothing; every due item and the guild back off', async () => {
  const cases = [
    { name: 'the system message alone is over the cap', maxRequestTokens: 10, briefs: ['της αρέσει ο καφές', 'της αρέσει η βροχή'] },
    { name: 'the fixed part fits, no due item does even alone', maxRequestTokens: 200, briefs: ['βροχή '.repeat(300), 'ήλιος '.repeat(300)] },
  ];
  for (const { name, maxRequestTokens, briefs } of cases) {
    await withStoreAsync(async (store) => {
      const guildId = 'g1';
      const hot = voiceHot();
      hot.config.llm.maxRequestTokens = maxRequestTokens;
      queueVoice(store, guildId, briefs.map((brief) => ({ kind: 'self', brief: [brief] })), VOICE_AT - MINUTE_MS, hot.config);
      const llm = voiceLlm({ word: () => 'κείμενο' });
      const updater = voiceUpdater(store, hot, llm);

      const { result, logs } = await withCapturedLogs(() => updater.runVoice(guildId));

      assert.equal(result.reason, 'token-limit', name);
      assert.equal(llm.calls.length, 0, `${name}: nothing sent`);
      assert.equal(store.state.data.voiceCount, 0, `${name}: counted only once there is something to send`);
      const queue = store.getVoiceQueue(guildId);
      assert.equal(queue.length, 2, name);
      assert.ok(queue.every((item) => item.attempts === 1 && item.misses === 0 && item.nextAt === VOICE_AT + 15 * MINUTE_MS), name);
      const failed = logs.find((entry) => entry.msg === 'memory: voice failed');
      assert.deepEqual({ reason: failed.reason, sent: failed.sent, backoffMinutes: failed.backoffMinutes }, { reason: 'token-limit', sent: 2, backoffMinutes: 15 }, name);
      assert.ok(!JSON.stringify(logs).includes('βροχή'), 'counts only');
      makeVoiceDue(store, guildId, VOICE_AT);
      assert.equal((await updater.runVoice(guildId)).reason, 'backoff', `${name}: the guild backs off`);
    });
  }
});

test('runVoice: a write the store refuses is apply-error, logged by the error name only, and the guild backs off', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = voiceHot();
    queueVoice(store, guildId, [{ kind: 'self', brief: ['της αρέσει ο καφές'] }], VOICE_AT - MINUTE_MS, hot.config);
    store.applySelfOps = () => {
      throw new TypeError('ο δίσκος αρνήθηκε');
    };
    const llm = voiceLlm({ word: () => 'μου αρέσει ο καφές' });
    const updater = voiceUpdater(store, hot, llm);

    const { result, logs } = await withCapturedLogs(() => updater.runVoice(guildId));

    assert.equal(result.reason, 'apply-error');
    assert.equal(llm.calls.length, 1);
    assert.equal(store.state.data.voiceCount, 1, 'the request went out');
    const failed = logs.find((entry) => entry.msg === 'memory: voice failed');
    assert.deepEqual(
      { level: failed.level, reason: failed.reason, error: failed.error, backoffMinutes: failed.backoffMinutes },
      { level: 'warn', reason: 'apply-error', error: 'TypeError', backoffMinutes: 15 },
    );
    assert.equal('detail' in failed, false);
    assert.ok(!JSON.stringify(logs).includes('δίσκος'), 'never the error message');
    assert.ok(!JSON.stringify(logs).includes('καφές'), 'never a text');
    assert.equal(store.getVoiceQueue(guildId).length, 1, 'the item stays queued');
    makeVoiceDue(store, guildId, VOICE_AT);
    assert.equal((await updater.runVoice(guildId)).reason, 'backoff');
    assert.equal(llm.calls.length, 1);
  });
});

// ---- the recent store in the analyzer (features.recent) --------------------------
// A guild batch shows the live recent lines in <recent_notes> so the analyzer does not write one
// moment twice, and its `recent` answer (add, remove) goes through the recent store
// (src/memory/recent.js). A line is never copied into a long-term store, and a private batch
// neither sees nor writes one.

const RECENT_NOW = Date.UTC(2026, 0, 9, 12);
const FROG_AT = Date.UTC(2026, 0, 9, 9, 19);

/** A recent line the way the store hands it over (src/memory/store.js#getRecent). */
function recentLine(id, hoursAgo, text, channelId = 'c1', weight = 2) {
  return { id, at: RECENT_NOW - hoursAgo * HOUR_MS, addedAt: null, channelId, text, who: [], weight };
}

/** One guild request carrying `recentLines`; `memory`/`llm`/`features` override makeConfig's own. */
function recentRequest(recentLines, { memory = {}, llm = {}, features, messages, privateChat, rosterProfiles, prompts } = {}) {
  const base = makeConfig();
  return buildMemoryRequest({
    prompts: prompts ?? { memory: 'x', labels },
    config: makeConfig({ memory: { ...base.memory, ...memory }, llm: { ...base.llm, ...llm }, ...(features ? { features } : {}) }),
    calibrator: createCalibrator(),
    profiles: {},
    guildMemory: {},
    messages: messages ?? [slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: RECENT_NOW - MINUTE_MS })],
    selfName: 'Nept',
    nameOf: (id) => ({ [ZOE]: 'Zoé', [BRAN]: 'Βράνος' })[id] ?? null,
    recentLines,
    now: RECENT_NOW,
    privateChat,
    rosterProfiles,
  });
}

/** The parsed `<recent_notes>` block of a request, or null when it is absent. */
function recentNotesOf(request) {
  const body = blockBody(request.messages[1].content, 'recent_notes');
  return body === null ? null : JSON.parse(body);
}

/** The transcript's own date and clock of `ms` (UTC, en-US): a note's `when`. */
function noteWhen(ms) {
  return `${formatDate(ms, 'UTC', 'en-US')} ${formatClock(ms, 'UTC', 'en-US')}`;
}

/** A batch over two channels: Zoé gives the persona a frog in c1 at 09:19, Bran writes in c2 at 09:25, Zoé again in c1 at 09:40. */
function frogBatch() {
  return [
    slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', authorId: ZOE, authorName: 'Zoé', content: 'σου φέρνω έναν βάτραχο', ts: FROG_AT }),
    slimMessage({ id: 'm2', channelId: 'c2', channelName: 'diary', authorId: BRAN, authorName: 'Βράνος', content: 'σήμερα έβρεξε', ts: FROG_AT + 6 * MINUTE_MS }),
    slimMessage({ id: 'm3', channelId: 'c1', channelName: 'general', authorId: ZOE, authorName: 'Zoé', content: 'πρόσεχέ τον', ts: FROG_AT + 21 * MINUTE_MS }),
  ];
}

/** applyMemoryUpdate's `recent` option for a batch of `messages`, as analyze() builds it from the live config. */
function recentOption(messages, overrides = {}) {
  return { ...memorySwitches(makeConfig(), () => RECENT_NOW).recent, messages, timezone: 'UTC', locale: 'en-US', ...overrides };
}

/** One guild apply of `update` for the authors Zoé and Bran over `messages`. */
function applyRecent(store, update, messages, options = {}) {
  return applyMemoryUpdate(store, 'g1', update, MEMORY_CFG, new Set([ZOE, BRAN]), {
    knownChannelIds: new Set(messages.map((m) => m.channelId)),
    recent: recentOption(messages),
    ...options,
  });
}

/** Store `items` (`{ text, at, channelId, weight? }`) as live lines at `now`. */
function seedRecent(store, items, now = RECENT_NOW) {
  return store.applyRecentOps('g1', items, { now, hours: 72 });
}

test('memory request: recent_notes carries the live lines, oldest first, with tokens as name (id:...)', () => {
  const lines = [
    recentLine(1, 80, 'μια παλιά σημείωση'),
    recentLine(2, 2, `<@${ZOE}> μου έδωσε έναν βάτραχο να τον προσέχω`, 'c1', 3),
    recentLine(3, 30, `<@${BRAN}> υποσχέθηκε ένα τραγούδι`, 'c2'),
  ];

  const request = recentRequest(lines);

  assert.deepEqual(recentNotesOf(request), [
    { id: 3, when: noteWhen(RECENT_NOW - 30 * HOUR_MS), text: `Βράνος (id:${BRAN}) υποσχέθηκε ένα τραγούδι` },
    { id: 2, when: noteWhen(RECENT_NOW - 2 * HOUR_MS), text: `Zoé (id:${ZOE}) μου έδωσε έναν βάτραχο να τον προσέχω` },
  ]);
  assert.equal(request.recentShown, 2);
  assert.deepEqual(request.recentIds, [3, 2]);
  assert.ok(!request.messages[1].content.includes('παλιά σημείωση'), 'a line past memory.recentHours is not shown');
  assert.ok(!request.messages[1].content.includes(`<@${ZOE}>`), 'no raw token reaches the analyzer');
});

test('memory request: recent_notes holds at most memory.recentShown of the newest lines; memory.recentHours narrows the window', () => {
  const lines = [1, 2, 3, 4, 5].map((n) => recentLine(n, 10 - n, `σημείωση ${n}`));

  assert.deepEqual(recentNotesOf(recentRequest(lines, { memory: { recentShown: 2 } })).map((note) => note.id), [4, 5]);
  assert.deepEqual(recentNotesOf(recentRequest(lines, { memory: { recentHours: 6 } })).map((note) => note.id), [4, 5]);
  const none = recentRequest(lines, { memory: { recentShown: 0 } });
  assert.equal(recentNotesOf(none), null, 'recentShown 0 shows none');
  assert.equal(none.recentShown, 0);
});

test('memory request: recent_notes sits after known_members and right before new_messages', () => {
  const pool = [poolProfile(BRAN, ['Βράνος'], '2026-01-05T00:00:00.000Z')];

  const content = recentRequest([recentLine(1, 1, 'έβρεξε όλο το πρωί')], { rosterProfiles: pool }).messages[1].content;

  const known = content.indexOf('<known_members>');
  const notes = content.indexOf('<recent_notes>');
  assert.ok(known !== -1 && known < notes, 'after the roster');
  assert.ok(content.includes('</recent_notes>\n\n<new_messages>'), 'right before the transcript');
});

test('memory request: recent_notes is cut before any transcript line and never fails the request', () => {
  const base = RECENT_NOW - HOUR_MS;
  const messages = [0, 1, 2, 3, 4, 5].map((i) =>
    slimMessage({ id: `m${i}`, authorId: '1', authorName: 'Aria', content: `message number ${i} ${'word '.repeat(30)}`, ts: base + i * MINUTE_MS }),
  );
  const lines = [1, 2, 3].map((n) => recentLine(n, n, `σημείωση ${n} ${'λέξη '.repeat(30)}`));
  const tight = { llm: { maxRequestTokens: 300, safetyMargin: 1 }, messages };

  const without = recentRequest([], tight);
  const withLines = recentRequest(lines, tight);

  assert.ok(without.deferred > 0, 'the transcript itself is cut at this budget');
  assert.equal(withLines.shown, without.shown, 'no transcript line gives way to a note');
  assert.equal(withLines.deferred, without.deferred);
  assert.equal(withLines.recentShown, 0);
  assert.equal(recentNotesOf(withLines), null);
  assert.equal(withLines.messages[1].content, without.messages[1].content);

  const roomy = recentRequest(lines, { messages });
  assert.equal(roomy.recentShown, 3, 'with room every live line is sent');
  assert.equal(roomy.deferred, 0);
});

test('memory request: a private batch carries no recent_notes', () => {
  const publicProfile = { id: '1', names: ['Aria'], interests: [], details: [], aliases: [] };

  const request = recentRequest([recentLine(1, 1, 'σημείωση για τον κήπο')], { privateChat: { publicProfile, now: RECENT_NOW } });

  assert.equal(recentNotesOf(request), null);
  assert.equal(request.recentShown, 0);
  assert.deepEqual(request.recentIds, []);
  assert.ok(!request.messages[1].content.includes('κήπο'));
});

test('memory request: features.recent false sends no recent_notes', () => {
  const request = recentRequest([recentLine(1, 1, 'σημείωση για τον κήπο')], { features: { recent: false } });

  assert.equal(recentNotesOf(request), null);
  assert.equal(request.recentShown, 0);
  assert.ok(!request.messages[1].content.includes('κήπο'));
});

test('memory request: the recent placeholders are filled from the live config; maxNewRecent is 0 with features.recent false', () => {
  const prompts = { memory: 'hours {{recentHours}}, at most {{maxNewRecent}}, {{recentChars}} chars', labels };

  const set = recentRequest([], { prompts, memory: { recentHours: 48, maxNewRecent: 2, recentChars: 120 } });
  const off = recentRequest([], { prompts, memory: { recentHours: 48, maxNewRecent: 2, recentChars: 120 }, features: { recent: false } });

  assert.equal(set.messages[0].content, 'hours 48, at most 2, 120 chars');
  assert.equal(off.messages[0].content, 'hours 48, at most 0, 120 chars', 'the field is ignored, so the prompt states that none is taken');
});

test('memory request: without now the recent window is measured from the batch\'s newest message', () => {
  const request = buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config: makeConfig(),
    calibrator: createCalibrator(),
    profiles: {},
    guildMemory: {},
    messages: [
      slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: RECENT_NOW - 5 * HOUR_MS }),
      slimMessage({ id: 'm2', authorId: '1', authorName: 'Aria', ts: RECENT_NOW - MINUTE_MS }),
    ],
    selfName: 'Nept',
    recentLines: [recentLine(1, 73, 'σημείωση έξω από το παράθυρο'), recentLine(2, 71, 'σημείωση μέσα στο παράθυρο')],
  });

  assert.deepEqual(recentNotesOf(request).map((note) => note.id), [2], '72 hours back from the newest message, not the oldest and not the wall clock');
});

test('memorySwitches: recent carries the live settings and the clock; features.recent false gives none', () => {
  const on = memorySwitches(makeConfig({ memory: { ...makeConfig().memory, recentHours: 48, maxNewRecent: 2, clampTolerance: 0.2 } }), () => RECENT_NOW).recent;
  assert.deepEqual(
    { enabled: on.enabled, hours: on.hours, maxNew: on.maxNew, clampTolerance: on.clampTolerance, now: on.now },
    { enabled: true, hours: 48, maxNew: 2, clampTolerance: 0.2, now: RECENT_NOW },
  );

  assert.equal(memorySwitches(makeConfig({ features: { recent: false } }), () => RECENT_NOW).recent, undefined);
});

test('resolveMoment: a time is matched in the named channel, a missing leading zero tolerated; else that channel\'s newest message', () => {
  const messages = frogBatch();
  const opts = { timezone: 'UTC', locale: 'en-US', channelIds: new Set(['c1', 'c2']), now: RECENT_NOW };

  assert.deepEqual(resolveMoment(messages, { time: '09:19', channel: 'c1' }, opts), { at: FROG_AT, channelId: 'c1' });
  assert.deepEqual(resolveMoment(messages, { time: '9:19', channel: 'c1' }, opts), { at: FROG_AT, channelId: 'c1' });
  assert.deepEqual(resolveMoment(messages, { time: '23:59', channel: 'c1' }, opts), { at: FROG_AT + 21 * MINUTE_MS, channelId: 'c1' }, 'a time in no channel');
  assert.deepEqual(resolveMoment(messages, { channel: 'c2' }, opts), { at: FROG_AT + 6 * MINUTE_MS, channelId: 'c2' });
  assert.deepEqual(resolveMoment([], { time: '09:19', channel: 'c1' }, opts), { at: RECENT_NOW, channelId: 'c1' }, 'no message: the clock');
});

test('resolveMoment: a time found only in another channel than the named one gives no channel', () => {
  const messages = frogBatch();
  const opts = { timezone: 'UTC', locale: 'en-US', channelIds: new Set(['c1', 'c2']), now: RECENT_NOW };

  // 09:25 is a message of c2 only: the channel and the minute disagree, and neither is followed.
  assert.deepEqual(resolveMoment(messages, { time: '09:25', channel: 'c1' }, opts), { at: FROG_AT + 21 * MINUTE_MS, channelId: null });
  assert.deepEqual(resolveMoment(messages, { time: '09:19', channel: 'c2' }, opts), { at: FROG_AT + 21 * MINUTE_MS, channelId: null });
  const both = [...messages, slimMessage({ id: 'm4', channelId: 'c2', channelName: 'diary', authorId: BRAN, ts: FROG_AT + 30 * 1000 })];
  assert.deepEqual(resolveMoment(both, { time: '09:19', channel: 'c1' }, opts), { at: FROG_AT, channelId: 'c1' }, 'the minute is in both: the named channel');
  assert.deepEqual(resolveMoment(both, { time: '09:19', channel: 'c2' }, opts), { at: FROG_AT + 30 * 1000, channelId: 'c2' });
});

test('resolveMoment: a channel that names no batch channel gives none; with no channel given only a one-channel batch gives one', () => {
  const messages = frogBatch();
  const opts = { timezone: 'UTC', locale: 'en-US', channelIds: new Set(['c1', 'c2']), now: RECENT_NOW };
  const none = { at: FROG_AT + 21 * MINUTE_MS, channelId: null };

  // 09:25 is a message of c2 only, yet the time never stands in for a channel.
  assert.deepEqual(resolveMoment(messages, { time: '09:25', channel: 'c9' }, opts), none, 'a channel the batch does not hold');
  assert.deepEqual(resolveMoment(messages, { time: '09:25' }, opts), none, 'two channels, none given');
  assert.deepEqual(resolveMoment(messages, { time: '23:59' }, opts), none, 'two channels, no match');
  assert.equal(resolveMoment(messages, { channel: 'c9' }, opts).channelId, null);
  assert.equal(resolveMoment(messages, { channel: '#staff' }, opts).channelId, null, 'a name no batch channel carries');
  assert.equal(resolveMoment(messages, { channel: { id: 'c1' } }, opts).channelId, null, 'not a reference at all');
  assert.equal(resolveMoment(messages, { channel: 123456789012345680 }, opts).channelId, null, 'an id that lost its precision');

  const oneChannel = messages.filter((m) => m.channelId === 'c1');
  const oneOpts = { ...opts, channelIds: new Set(['c1']) };
  assert.deepEqual(resolveMoment(oneChannel, { time: '09:19' }, oneOpts), { at: FROG_AT, channelId: 'c1' }, 'one channel, none given');
  assert.deepEqual(resolveMoment(oneChannel, { time: '23:59', channel: '  ' }, oneOpts), { at: FROG_AT + 21 * MINUTE_MS, channelId: 'c1' }, 'a blank channel is none given');
  assert.deepEqual(resolveMoment(oneChannel, { time: '09:19', channel: 'c9' }, oneOpts), none, 'a channel the batch lacks is never replaced by its only one');
  assert.equal(resolveMoment(messages, { time: '09:25', channel: 'c2' }, oneOpts).channelId, null, 'a channel outside the known set is never taken');
});

test('resolveMoment: a channel given as #name, its name, <#id> or the heading\'s #name (id:...) is that channel, and the conflict rule still applies', () => {
  const messages = frogBatch(); // c1 is #general, c2 is #diary
  const opts = { timezone: 'UTC', locale: 'en-US', channelIds: new Set(['c1', 'c2']), now: RECENT_NOW };
  const none = { at: FROG_AT + 21 * MINUTE_MS, channelId: null };

  for (const ref of ['#general', 'general', 'GENERAL', '#General', '<#c1>', '#general (id:c1)', ' c1 ']) {
    assert.deepEqual(resolveMoment(messages, { time: '09:19', channel: ref }, opts), { at: FROG_AT, channelId: 'c1' }, ref);
    assert.deepEqual(resolveMoment(messages, { time: '23:59', channel: ref }, opts), { at: FROG_AT + 21 * MINUTE_MS, channelId: 'c1' }, `${ref}: no minute matches`);
    assert.deepEqual(resolveMoment(messages, { time: '09:25', channel: ref }, opts), none, `${ref}: the minute is #diary's only`);
  }
  // A line of #diary dated by a minute only #general has: never filed under #general.
  assert.deepEqual(resolveMoment(messages, { time: '09:19', channel: '#diary' }, opts), none);
  assert.deepEqual(resolveMoment(messages, { time: '09:25', channel: '#diary' }, opts), { at: FROG_AT + 6 * MINUTE_MS, channelId: 'c2' });
  assert.equal(resolveMoment(messages, { time: '09:19', channel: '<#c9>' }, opts).channelId, null, 'a mention of a channel outside the batch');
  assert.equal(resolveMoment(messages, { time: '09:19', channel: '#general (id:c9)' }, opts).channelId, null, 'the heading\'s id decides, not its name');
  const twins = [...messages, slimMessage({ id: 'm4', channelId: 'c3', channelName: 'General', authorId: BRAN, ts: FROG_AT + 25 * MINUTE_MS })];
  const twinOpts = { ...opts, channelIds: new Set(['c1', 'c2', 'c3']) };
  assert.equal(resolveMoment(twins, { time: '09:19', channel: '#general' }, twinOpts).channelId, null, 'a name two batch channels share');
});

test('memory update: a recent add is tokenized, dated by its HH:MM and stored with its channel', () => {
  withStore((store) => {
    const update = { recent: { add: [{ text: `Η Zoé (id:${ZOE}) μου έδωσε έναν βάτραχο να τον προσέχω`, time: '09:19', channel: 'c1', weight: 3 }] } };

    const result = applyRecent(store, update, frogBatch());

    assert.equal(result.recentAdded, 1);
    const [line] = store.getRecent('g1').lines;
    assert.deepEqual(
      { text: line.text, at: line.at, channelId: line.channelId, who: line.who, weight: line.weight },
      { text: `Η <@${ZOE}> μου έδωσε έναν βάτραχο να τον προσέχω`, at: FROG_AT, channelId: 'c1', who: [ZOE], weight: 3 },
    );
  });
});

test('memory update: an unmatched time dates the line by the newest message of its channel', () => {
  withStore((store) => {
    const update = {
      recent: {
        add: [
          { text: 'η βροχή κράτησε όλο το πρωί', time: '23:59', channel: 'c1' },
          { text: 'ο Βράνος έγραψε για τη βροχή', channel: 'c2' },
        ],
      },
    };

    applyRecent(store, update, frogBatch());

    assert.deepEqual(
      store.getRecent('g1').lines.map((line) => [line.channelId, line.at]),
      [
        ['c1', FROG_AT + 21 * MINUTE_MS],
        ['c2', FROG_AT + 6 * MINUTE_MS],
      ],
    );
  });
});

test('memory update: a recent add naming a channel the batch does not hold, or none in a batch of several channels, keeps no channel and is not stored', () => {
  withStore((store) => {
    const update = {
      recent: [
        // 09:25 is a message of c2 only: the time never stands in for the channel.
        { text: 'ο Βράνος μίλησε για τη βροχή', time: '09:25', channel: 'c9' },
        { text: 'κάποιος ανέφερε μια γιορτή', time: '09:25' },
        { text: 'κάτι συνέβη κάπου', channel: 'c9' },
      ],
    };

    const result = applyRecent(store, update, frogBatch());

    assert.deepEqual([result.recentAdded, result.recentNoChannel, result.recentDropped], [0, 3, 3], 'a bare list is read as add');
    assert.deepEqual(store.getRecent('g1').lines, []);
  });

  withStore((store) => {
    const oneChannel = frogBatch().filter((m) => m.channelId === 'c1');

    const result = applyRecent(store, { recent: [{ text: 'η Zoé έφερε έναν βάτραχο', time: '09:19' }] }, oneChannel);

    assert.equal(result.recentAdded, 1, 'a batch of one channel says where a line with none comes from');
    assert.deepEqual(store.getRecent('g1').lines.map((line) => [line.text, line.at, line.channelId]), [['η Zoé έφερε έναν βάτραχο', FROG_AT, 'c1']]);
  });
});

test('memory update: every recent add or remove the code throws away is counted by its reason and in recentDropped', () => {
  withStore((store) => {
    seedRecent(store, [{ text: 'Η βροχή σταμάτησε', at: FROG_AT, channelId: 'c1' }]);
    const messages = frogBatch();
    const update = {
      recent: {
        add: [
          'σκέτο κείμενο',
          { text: '   ', channel: 'c1' },
          { text: 42, channel: 'c1' },
          { text: 'η βροχη  σταματησε', channel: 'c1' },
          { text: 'ένα', channel: 'c1' },
          { text: 'δύο', channel: 'c1' },
        ],
        remove: [1],
      },
    };

    const result = applyRecent(store, update, messages, { recent: recentOption(messages, { maxNew: 1, shownIds: new Set() }) });

    assert.deepEqual(
      {
        added: result.recentAdded,
        invalid: result.recentInvalid,
        duplicate: result.recentDuplicate,
        overCap: result.recentOverCap,
        unshown: result.recentUnshown,
        removed: result.recentRemoved,
        noChannel: result.recentNoChannel,
        stale: result.recentStale,
        dropped: result.recentDropped,
      },
      { added: 1, invalid: 3, duplicate: 1, overCap: 1, unshown: 1, removed: 0, noChannel: 0, stale: 0, dropped: 6 },
    );
    assert.deepEqual(store.getRecent('g1').lines.map((line) => line.text), ['Η βροχή σταμάτησε', 'ένα']);
  });

  withStore((store) => {
    const messages = frogBatch();

    // A one-hour window: the batch's 09:19 is past it already.
    const result = applyRecent(store, { recent: { add: [{ text: 'μια παλιά στιγμή', time: '09:19', channel: 'c1' }] } }, messages, {
      recent: recentOption(messages, { hours: 1 }),
    });

    assert.deepEqual([result.recentAdded, result.recentStale, result.recentDropped], [0, 1, 1]);
    assert.deepEqual(store.getRecent('g1').lines, []);
  });
});

test('memory update: stored lines the storage cap pushes out are counted in recentEvicted', () => {
  withStore((store) => {
    seedRecent(store, [
      { text: 'ελαφριά σημείωση', at: FROG_AT, channelId: 'c1', weight: 1 },
      { text: 'βαριά σημείωση', at: FROG_AT, channelId: 'c1', weight: 3 },
    ]);
    const messages = frogBatch();

    const result = applyRecent(store, { recent: { add: [{ text: 'καινούργια σημείωση', channel: 'c1' }] } }, messages, {
      recent: recentOption(messages, { maxStored: 2 }),
    });

    assert.deepEqual([result.recentAdded, result.recentEvicted, result.recentDropped], [1, 1, 0]);
    assert.deepEqual(store.getRecent('g1').lines.map((line) => line.text), ['βαριά σημείωση', 'καινούργια σημείωση']);
  });
});

test('memory update: a recent add equal to an episode, a lesson, a self fact or a lore entry of the same update is dropped and counted', () => {
  withStore((store) => {
    store.touchUser('g1', ZOE, 'Zoé', FROG_AT - DAY_MS);
    const messages = frogBatch();
    const update = {
      users: { [ZOE]: { episodes: [{ date: '2026-01-09', what: `Η Zoé (id:${ZOE}) μου χάρισε έναν βάτραχο`, weight: 3 }] } },
      guild: { learned: { add: [{ text: 'Το γκγκ σημαίνει καληνύχτα' }] } },
      self: ['Φυλάω έναν βάτραχο στο συρτάρι'],
      lore: [{ title: 'Ο βάτραχος', keys: ['βάτραχος'], text: 'Ο βάτραχος του σέρβερ ζει στο general' }],
      recent: {
        add: [
          { text: `η <@${ZOE}> μου χάρισε έναν  βατραχο`, time: '09:19', channel: 'c1' },
          { text: 'το γκγκ σημαίνει καληνύχτα', time: '09:19', channel: 'c1' },
          { text: 'Φυλάω έναν βάτραχο στο συρτάρι', channel: 'c1' },
          { text: 'Ο βάτραχος του σέρβερ ζει στο general', channel: 'c1' },
          { text: 'ο Βράνος είπε ότι αύριο βρέχει', time: '09:25', channel: 'c2' },
        ],
      },
    };

    const result = applyRecent(store, update, messages, { episodes: EPISODES_CFG, lore: LORE_CFG, recent: recentOption(messages, { maxNew: 1 }) });

    assert.equal(result.recentOverlap, 4, 'case, accents, spacing and the token form are folded away');
    assert.equal(result.recentAdded, 1, 'an overlap takes no slot of maxNewRecent');
    assert.deepEqual(store.getRecent('g1').lines.map((line) => line.text), ['ο Βράνος είπε ότι αύριο βρέχει']);
    assert.equal(result.episodes, 1, 'the long-term stores take their own entries');
    assert.equal(result.lore, 1);
    assert.equal(result.learned, 1);
    assert.equal(result.self, true);
  });
});

test('memory update: an add equal to an entry no long-term store was offered (a non-author\'s episode, lore off) is kept', () => {
  withStore((store) => {
    const messages = frogBatch();
    const update = {
      users: { 999999999999999999: { episodes: [{ what: 'μια στιγμή κάποιου άγνωστου' }] } },
      lore: [{ title: 'Ο κήπος', keys: ['κήπος'], text: 'Ο κήπος ανθίζει' }],
      recent: { add: [{ text: 'μια στιγμή κάποιου άγνωστου', channel: 'c1' }, { text: 'Ο κήπος ανθίζει', channel: 'c1' }] },
    };

    // A member outside the batch and no lore option: neither entry is stored, so neither is the moment's home.
    const result = applyRecent(store, update, messages, { episodes: EPISODES_CFG });

    assert.equal(result.recentOverlap, 0);
    assert.equal(result.recentAdded, 2);
  });
});

test('memory update: an add equal to an episode past memory.maxNewEpisodes or a self fact past memory.maxSelfFacts is kept', () => {
  withStore((store) => {
    store.touchUser('g1', ZOE, 'Zoé', FROG_AT - DAY_MS);
    const messages = frogBatch();
    const frog = `η <@${ZOE}> μου χάρισε έναν βάτραχο`;
    const update = {
      users: { [ZOE]: { episodes: [{ what: '' }, { what: 'πρώτη στιγμή' }, { what: 'δεύτερη στιγμή' }, { what: 'τρίτη στιγμή' }, { what: frog }] } },
      self: ['μου αρέσει η βροχή', 'φυλάω έναν βάτραχο'],
      recent: {
        add: [
          { text: 'τρίτη στιγμή', channel: 'c1' },
          { text: frog, channel: 'c1' },
          { text: 'μου αρέσει η βροχή', channel: 'c1' },
          { text: 'φυλάω έναν βάτραχο', channel: 'c1' },
        ],
      },
    };

    // EPISODES_CFG takes 3 new episodes per member: the 3 usable ones before the frog.
    const result = applyMemoryUpdate(store, 'g1', update, { ...MEMORY_CFG, maxSelfFacts: 1 }, new Set([ZOE, BRAN]), {
      knownChannelIds: new Set(['c1', 'c2']),
      episodes: EPISODES_CFG,
      recent: recentOption(messages, { maxNew: 5 }),
    });

    assert.equal(result.episodes, 3);
    assert.deepEqual(store.getGuild('g1').self, ['μου αρέσει η βροχή']);
    assert.equal(result.recentOverlap, 2, 'the third episode and the one self fact the stores took');
    assert.deepEqual(store.getRecent('g1').lines.map((line) => line.text), [frog, 'φυλάω έναν βάτραχο']);
  });
});

test('memory update: recent adds are clamped, capped at memory.maxNewRecent and never stored twice', () => {
  withStore((store) => {
    seedRecent(store, [{ text: 'Η βροχή σταμάτησε', at: FROG_AT, channelId: 'c1' }]);
    const long = `${'μια πολύ μεγάλη πρόταση για τη βροχή '.repeat(10)}τέλος`;
    const update = {
      recent: {
        add: [
          { text: 'η βροχη  σταματησε', channel: 'c1' },
          { text: long, channel: 'c1' },
          { text: 'ένα', channel: 'c1' },
          { text: 'δύο', channel: 'c1' },
          { text: 'τρία', channel: 'c1' },
        ],
      },
    };

    const messages = frogBatch();
    const result = applyRecent(store, update, messages, { recent: recentOption(messages, { chars: 40, clampTolerance: 1 }) });

    assert.equal(result.recentAdded, 3, 'the first three new ones, after the duplicate');
    const texts = store.getRecent('g1').lines.map((line) => line.text);
    assert.equal(texts.length, 4);
    assert.equal(texts[0], 'Η βροχή σταμάτησε');
    assert.ok(texts[1].length <= 40 && long.startsWith(texts[1]), 'cut to memory.recentChars at a word boundary');
    assert.deepEqual(texts.slice(2), ['ένα', 'δύο']);
  });
});

test('memory update: recent remove deletes only the stored ids the request showed', () => {
  withStore((store) => {
    seedRecent(store, [
      { text: 'πρώτη', at: FROG_AT, channelId: 'c1' },
      { text: 'δεύτερη', at: FROG_AT, channelId: 'c1' },
      { text: 'τρίτη', at: FROG_AT, channelId: 'c1' },
    ]);
    const messages = frogBatch();

    // true, [1], '1e0', '0x1' and '1.0' all coerce to 1 but are no id by the store's rule.
    const remove = [1, '2', 3, 99, 'x', true, [1], '1e0', '0x1', '1.0'];
    const result = applyRecent(store, { recent: { remove } }, messages, { recent: recentOption(messages, { shownIds: new Set([1, 2]) }) });

    assert.equal(result.recentRemoved, 2);
    assert.deepEqual([result.recentUnshown, result.recentDropped], [8, 8], '3 and 99 were not shown, the other six are no id');
    assert.deepEqual(store.getRecent('g1').lines.map((line) => line.id), [3], 'a line the request never showed stays');

    const byText = applyRecent(store, { recent: { remove: ['τρίτη', { id: 3 }] } }, messages);
    assert.deepEqual([byText.recentRemoved, byText.recentUnshown], [0, 2], 'by id only, never by text; an entry that is no id is counted');
    const direct = applyRecent(store, { recent: { remove: [3] } }, messages);
    assert.equal(direct.recentRemoved, 1, 'without shown ids any stored id may go');
    assert.deepEqual(store.getRecent('g1').lines, []);
  });
});

test('memory update: a recent line is never copied into a long-term store', () => {
  withStore((store) => {
    store.touchUser('g1', ZOE, 'Zoé', FROG_AT - DAY_MS);
    seedRecent(store, [{ text: `<@${ZOE}> μου έδωσε έναν βάτραχο`, at: FROG_AT, channelId: 'c1' }]);
    const before = JSON.stringify([store.getUser('g1', ZOE), store.getGuild('g1'), store.getLore('g1')]);
    const messages = frogBatch();

    applyRecent(store, { recent: { add: [{ text: 'ο Βράνος υποσχέθηκε ένα τραγούδι', channel: 'c2' }], remove: [1] } }, messages, {
      episodes: EPISODES_CFG,
      lore: LORE_CFG,
      relationships: RELATIONSHIPS_CFG,
    });

    assert.equal(JSON.stringify([store.getUser('g1', ZOE), store.getGuild('g1'), store.getLore('g1')]), before);
    assert.deepEqual(store.getRecent('g1').lines.map((line) => line.text), ['ο Βράνος υποσχέθηκε ένα τραγούδι']);
  });
});

test('memory update: features.recent false ignores the field and expires nothing; on, an old line expires at the next batch', () => {
  withStore((store) => {
    seedRecent(store, [{ text: 'μια σημείωση από πριν', at: RECENT_NOW - 100 * HOUR_MS, channelId: 'c1' }], RECENT_NOW - 99 * HOUR_MS);
    const messages = frogBatch();
    const update = { recent: { add: [{ text: 'καινούργια σημείωση', channel: 'c1' }] } };
    const off = memorySwitches(makeConfig({ features: { recent: false } }), () => RECENT_NOW).recent;

    const ignored = applyRecent(store, update, messages, { recent: off });

    assert.deepEqual([ignored.recentAdded, ignored.recentOverlap, ignored.recentRemoved, ignored.recentExpired], [0, 0, 0, 0]);
    assert.deepEqual(store.getRecent('g1').lines.map((line) => line.text), ['μια σημείωση από πριν']);

    const applied = applyRecent(store, update, messages);
    assert.equal(applied.recentExpired, 1);
    assert.equal(applied.recentAdded, 1);
    assert.deepEqual(store.getRecent('g1').lines.map((line) => line.text), ['καινούργια σημείωση']);
  });
});

test('private update: a recent field is dropped and counted', () => {
  withStore((store) => {
    const update = { users: { u1: { relationship: 'μιλάμε συχνά' } }, recent: { add: [{ text: 'α', channel: 'dm1' }, { text: 'β' }], remove: [1] } };

    const result = applyPrivateUpdate(store, 'g1', 'u1', update, MEMORY_CFG);

    assert.equal(result.dropped.recent, 3);
    assert.deepEqual(store.getRecent('g1').lines, []);
    assert.equal(applyPrivateUpdate(store, 'g1', 'u1', { recent: [{ text: 'γ' }] }, MEMORY_CFG).dropped.recent, 1, 'a bare list counts its items');
  });
});

test('analyzePrivate: a private batch shows no recent_notes and never writes the recent store', async () => {
  await withStoreAsync(async (store) => {
    seedRecent(store, [{ text: 'σημείωση για τον κήπο', at: RECENT_NOW - HOUR_MS, channelId: 'c1' }]);
    const llm = recordingLlm({ users: { u1: { relationship: 'μιλάμε' } }, recent: { add: [{ text: 'ιδιωτική στιγμή', channel: 'dm1' }], remove: [1] } });
    const updater = createMemoryUpdater({ hot: privateHot(), store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => RECENT_NOW });

    const outcome = await updater.analyzePrivate('g1', 'u1', [dmMessage({ id: 'm1', ts: RECENT_NOW - MINUTE_MS })]);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.dropped.recent, 2);
    assert.equal(blockBody(llm.calls[0].messages[1].content, 'recent_notes'), null);
    assert.ok(!llm.calls[0].messages[1].content.includes('κήπο'));
    assert.deepEqual(store.getRecent('g1').lines.map((line) => line.text), ['σημείωση για τον κήπο']);
  });
});

test("run: the request shows the live lines, the answer's recent field applies and the expired line is not counted as removed", async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    seedRecent(
      store,
      [
        { text: 'μια σημείωση που λήγει', at: RECENT_NOW - 100 * HOUR_MS, channelId: 'c1' },
        { text: 'ο κήπος άνθισε', at: RECENT_NOW - 2 * HOUR_MS, channelId: 'c1' },
      ],
      RECENT_NOW - 99 * HOUR_MS,
    );
    for (const message of frogBatch()) store.pushBuffer(guildId, message, 100);
    const llm = recordingLlm({ recent: { add: [{ text: `η <@${ZOE}> μου έφερε έναν βάτραχο`, time: '09:19', channel: 'c1' }], remove: [2, 1] } });
    const hot = { config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 3, minBatchMessages: 1 } }), prompts: { memory: 'memory system prompt', labels } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => RECENT_NOW });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));

    assert.deepEqual(
      JSON.parse(blockBody(llm.calls[0].messages[1].content, 'recent_notes')).map((note) => note.id),
      [2],
      'the expired line is not shown',
    );
    assert.deepEqual(store.getRecent(guildId).lines.map((line) => [line.text, line.at, line.channelId]), [[`η <@${ZOE}> μου έφερε έναν βάτραχο`, FROG_AT, 'c1']]);
    const applied = logs.find((entry) => entry.msg === 'memory: update applied');
    assert.deepEqual(
      { recentExpired: applied.recentExpired, recentRemoved: applied.recentRemoved, recentUnshown: applied.recentUnshown },
      { recentExpired: 1, recentRemoved: 1, recentUnshown: 1 },
      'the expired line is counted as expired, not as removed; its remove as one of a line not shown',
    );
    assert.ok(!JSON.stringify(logs).includes('βάτραχο'), 'counts only');
  });
});

test('run: the notes the analyzer is shown are the lines live at the updater\'s clock, not at the batch\'s newest message', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    // 73 h less 30 min before the clock (12:00): past memory.recentHours (72) at the clock, inside
    // it at the batch's newest message (09:40).
    seedRecent(
      store,
      [
        { text: 'μια σημείωση στο όριο', at: RECENT_NOW - 73 * HOUR_MS + 30 * MINUTE_MS, channelId: 'c1' },
        { text: 'ο κήπος άνθισε', at: RECENT_NOW - 2 * HOUR_MS, channelId: 'c1' },
      ],
      RECENT_NOW - 2 * HOUR_MS,
    );
    for (const message of frogBatch()) store.pushBuffer(guildId, message, 100);
    const llm = recordingLlm({});
    const hot = { config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 3, minBatchMessages: 1 } }), prompts: { memory: 'memory system prompt', labels } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => RECENT_NOW });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));

    assert.equal(llm.calls.length, 1);
    assert.deepEqual(JSON.parse(blockBody(llm.calls[0].messages[1].content, 'recent_notes')).map((note) => note.text), ['ο κήπος άνθισε']);
    assert.equal(logs.find((entry) => entry.msg === 'memory: update applied').recentShown, 1);
  });
});

test('run: a remove takes only a line the request showed; one it did not show stays and is counted', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    seedRecent(store, [
      { text: 'ο κήπος άνθισε', at: RECENT_NOW - 3 * HOUR_MS, channelId: 'c1' },
      { text: 'έβρεξε όλο το πρωί', at: RECENT_NOW - 2 * HOUR_MS, channelId: 'c1' },
    ]);
    for (const message of frogBatch()) store.pushBuffer(guildId, message, 100);
    const llm = recordingLlm({ recent: { remove: [1, 2] } });
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 3, minBatchMessages: 1, recentShown: 1 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => RECENT_NOW });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));

    assert.deepEqual(JSON.parse(blockBody(llm.calls[0].messages[1].content, 'recent_notes')).map((note) => note.id), [2], 'only the newer line is shown');
    assert.deepEqual(store.getRecent(guildId).lines.map((line) => line.id), [1], 'the line the request never showed stays');
    const applied = logs.find((entry) => entry.msg === 'memory: update applied');
    assert.deepEqual([applied.recentRemoved, applied.recentUnshown, applied.recentDropped], [1, 1, 1]);
  });
});

test('run: an answer with no recent field still expires the lines past memory.recentHours; with features.recent false they stay', async () => {
  for (const [features, expired, left] of [
    [{}, 1, []],
    [{ recent: false }, 0, ['μια σημείωση που λήγει']],
  ]) {
    await withStoreAsync(async (store) => {
      const guildId = 'g1';
      seedRecent(store, [{ text: 'μια σημείωση που λήγει', at: RECENT_NOW - 100 * HOUR_MS, channelId: 'c1' }], RECENT_NOW - 99 * HOUR_MS);
      for (const message of frogBatch()) store.pushBuffer(guildId, message, 100);
      const llm = recordingLlm({ users: { [ZOE]: { details: { add: ['μένει κοντά στη θάλασσα'] } } } });
      const hot = {
        config: makeConfig({ features, memory: { ...makeConfig().memory, batchMessages: 3, minBatchMessages: 1 } }),
        prompts: { memory: 'memory system prompt', labels },
      };
      const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => RECENT_NOW });

      const { logs } = await withCapturedLogs(() => updater.run(guildId));

      assert.equal(logs.find((entry) => entry.msg === 'memory: update applied').recentExpired, expired, JSON.stringify(features));
      assert.deepEqual(store.getRecent(guildId).lines.map((line) => line.text), left);
    });
  }
});

test('analyze (two-stage): stage A sees the notes, writes a recent add itself and queues no voice item for it', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, ZOE, 'Zoé', FROG_AT - DAY_MS);
    seedRecent(store, [{ text: 'ο κήπος άνθισε', at: RECENT_NOW - 2 * HOUR_MS, channelId: 'c1' }]);
    const llm = recordingLlm({
      self: { add: ['φυλάει έναν βάτραχο'] },
      guild: { learned: { add: [{ brief: 'Το γκγκ σημαίνει καληνύχτα' }] } },
      recent: {
        add: [
          { text: 'Φυλάει έναν βάτραχο', time: '09:19', channel: 'c1' },
          { text: 'το γκγκ σημαινει  καληνυχτα', time: '09:19', channel: 'c1' },
          { text: 'ο Βράνος υποσχέθηκε ένα τραγούδι', time: '09:25', channel: 'c2', weight: 3 },
        ],
      },
    });
    const updater = createMemoryUpdater({ hot: twoStageHot(), store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => RECENT_NOW });

    const outcome = await updater.analyze(guildId, frogBatch());

    assert.equal(outcome.ok, true);
    assert.equal(outcome.stage, 'two');
    assert.ok(llm.calls[0].messages[0].content.startsWith('decide prompt for Nept'), 'the stage A request');
    assert.deepEqual(JSON.parse(blockBody(llm.calls[0].messages[1].content, 'recent_notes')).map((note) => note.text), ['ο κήπος άνθισε']);
    assert.equal(outcome.result.recentOverlap, 2, 'a self claim and a lesson of the same answer are their home, case and accents folded');
    assert.equal(outcome.result.recentAdded, 1);
    assert.deepEqual(
      store.getRecent(guildId).lines.map((line) => [line.text, line.channelId, line.weight]),
      [
        ['ο κήπος άνθισε', 'c1', 2],
        ['ο Βράνος υποσχέθηκε ένα τραγούδι', 'c2', 3],
      ],
    );
    assert.deepEqual(queuedKinds(store, guildId), ['learned', 'self'], 'only the lesson and the self claim wait for the voice model');
  });
});

// ---- the analyzer's profile view: capped lists, whole or compact by lines shown ----

/** A stored-shape profile whose `character` is `chars` Greek letters long (one raw token per two). */
function heavyProfile(name, chars, extra = {}) {
  return { names: [name], character: 'λ'.repeat(chars), style: '', relationship: '', interests: [], details: [], ...extra };
}

/** One guild line of `authorId` at `ts`. */
function authorLine(id, authorId, authorName, ts) {
  return slimMessage({ id, authorId, authorName, content: 'γεια', ts });
}

/** makeConfig() with `llm.maxRequestTokens` = `tokens` (no safety margin) and `memory` merged in. */
function budgetConfig(tokens, memory = {}) {
  const base = makeConfig();
  return makeConfig({ llm: { ...base.llm, maxRequestTokens: tokens, safetyMargin: 1 }, memory: { ...base.memory, ...memory } });
}

const profilesOf = (request) => JSON.parse(blockBody(request.messages[1].content, 'existing_profiles'));

test('buildMemoryRequest: existing_profiles sends at most memory.analyzerEpisodes episodes, heaviest then newest, and the stored list keeps every one', () => {
  const episodes = [
    { date: '2026-01-01', what: 'α', quote: '', feeling: '', weight: 2 },
    { date: '2026-01-02', what: 'β', quote: '', feeling: '', weight: 5 },
    { date: '2026-01-03', what: 'γ', quote: '', feeling: '', weight: 2 },
    { date: '2026-01-04', what: 'δ', quote: '', feeling: '', weight: 1 },
  ];
  const profile = heavyProfile('Zoé', 10, { episodes });
  const build = (analyzerEpisodes) =>
    buildMemoryRequest({
      prompts: { memory: 'sys', labels },
      config: makeConfig({ memory: { ...makeConfig().memory, analyzerEpisodes } }),
      calibrator: createCalibrator(),
      profiles: { 1: profile },
      guildMemory: {},
      messages: [authorLine('m1', '1', 'Zoé', Date.UTC(2026, 0, 5, 12))],
      selfName: 'Nept',
    });

  assert.deepEqual(profilesOf(build(2))['1'].episodes.map((ep) => ep.what), ['β', 'γ'], 'the first two of the reply side order');
  assert.deepEqual(profilesOf(build(10))['1'].episodes.map((ep) => ep.what), ['β', 'γ', 'α', 'δ'], 'fewer than the cap: all, in that order');
  assert.equal('episodes' in profilesOf(build(0))['1'], false, '0 sends none');
  assert.deepEqual(profile.episodes.map((ep) => ep.what), ['α', 'β', 'γ', 'δ'], 'the stored profile is never trimmed');
});

test('analyze: an episode equal to a stored one the request did not show is still rejected by code', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const at = Date.UTC(2026, 0, 10, 12);
    store.touchUser(guildId, '1', 'Zoé', at - DAY_MS);
    store.addEpisodes(
      guildId,
      '1',
      [
        { date: '2026-01-02', what: 'έφερε γλυκά', weight: 5 },
        { date: '2026-01-03', what: 'τραγούδησε', weight: 4 },
        { date: '2026-01-04', what: 'έχασε το κλειδί', weight: 1 },
      ],
      { maxEpisodes: 20, maxNew: 5, now: at - DAY_MS },
    );
    const llm = recordingLlm({ users: { 1: { episodes: [{ date: '2026-01-04', what: 'Έχασε  το κλειδί', weight: 2 }] } } });
    const hot = { config: makeConfig({ memory: { ...makeConfig().memory, analyzerEpisodes: 2 } }), prompts: { memory: 'sys', labels } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => at });

    const outcome = await updater.analyze(guildId, [authorLine('m1', '1', 'Zoé', at - MINUTE_MS)]);

    assert.equal(outcome.ok, true);
    assert.deepEqual(profilesOf(llm.calls[0])['1'].episodes.map((ep) => ep.what), ['έφερε γλυκά', 'τραγούδησε'], 'the light one was not shown');
    assert.equal(outcome.result.episodes, 0, 'the same moment is not stored twice');
    assert.deepEqual(store.getUser(guildId, '1').episodes.map((ep) => ep.what), ['έφερε γλυκά', 'τραγούδησε', 'έχασε το κλειδί']);
  });
});

test('buildMemoryRequest: with a tight budget the authors with the most lines shown keep their whole profile, the others go compact', () => {
  const t0 = Date.UTC(2026, 0, 5, 12);
  // Cyra writes first but least; Aria most.
  const messages = [
    authorLine('m1', '3', 'Cyra', t0),
    authorLine('m2', '2', 'Bea', t0 + 1000),
    authorLine('m3', '1', 'Aria', t0 + 2000),
    authorLine('m4', '1', 'Aria', t0 + 3000),
    authorLine('m5', '2', 'Bea', t0 + 4000),
    authorLine('m6', '1', 'Aria', t0 + 5000),
  ];
  const profiles = { 1: heavyProfile('Aria', 1600), 2: heavyProfile('Bea', 1600), 3: heavyProfile('Cyra', 1600) };
  const build = (config) =>
    buildMemoryRequest({ prompts: { memory: 'sys', labels }, config, calibrator: createCalibrator(), profiles, guildMemory: {}, messages, selfName: 'Nept' });

  // Room for the transcript and one whole profile (about 800 tokens each), not two.
  const tight = build(budgetConfig(1400));
  const sent = profilesOf(tight);
  assert.equal(tight.shown, 6, 'every line is read: the profiles take only what the transcript left');
  assert.equal(sent['1'].character, profiles[1].character, 'the busiest author is whole');
  for (const id of ['2', '3']) {
    assert.deepEqual(Object.keys(sent[id]).sort(), ['affinity', 'compact', 'names'], `${id}: id, names and attitude only`);
    assert.equal(sent[id].compact, true);
    assert.deepEqual(sent[id].names, profiles[id].names);
  }
  assert.deepEqual([tight.profilesWhole, tight.profilesCompact], [1, 2]);
  const blockText = `<existing_profiles>\n${blockBody(tight.messages[1].content, 'existing_profiles')}\n</existing_profiles>`;
  assert.equal(tight.profilesTokens, createCalibrator().apply(estimateTokens(blockText)) + 2);

  const roomy = build(budgetConfig(50000));
  assert.deepEqual([roomy.profilesWhole, roomy.profilesCompact], [3, 0]);
  assert.equal(profilesOf(roomy)['3'].character, profiles[3].character);
  assert.ok(roomy.profilesTokens > tight.profilesTokens);
});

test('run: a compact author is still written, and "memory: update applied" counts the profiles sent whole and compact and the block tokens', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const t0 = Date.UTC(2026, 0, 5, 12);
    for (const [id, name] of [['1', 'Aria'], ['2', 'Bea']]) {
      store.touchUser(guildId, id, name, t0 - DAY_MS);
      store.applyProfileOps(guildId, id, { character: 'λ'.repeat(1600) }, { fieldChars: 2000 });
    }
    for (const message of [authorLine('m1', '2', 'Bea', t0), authorLine('m2', '1', 'Aria', t0 + 1000), authorLine('m3', '1', 'Aria', t0 + 2000)]) {
      store.pushBuffer(guildId, message, 100);
    }
    const llm = recordingLlm({ users: { 2: { interests: { add: [{ topic: 'κιθάρα', note: 'παίζει τα βράδια' }] } } } });
    const hot = { config: budgetConfig(1300, { batchMessages: 3, minBatchMessages: 1 }), prompts: { memory: 'sys', labels } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => t0 + HOUR_MS });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));

    const sent = profilesOf(llm.calls[0]);
    assert.equal(sent['2'].compact, true, 'Bea went compact');
    assert.equal(sent['1'].compact, undefined, 'Aria went whole');
    assert.deepEqual(store.getUser(guildId, '2').interests.map((item) => item.topic), ['κιθάρα'], 'the update for the compact author is applied');
    const applied = logs.find((entry) => entry.msg === 'memory: update applied');
    assert.deepEqual([applied.profilesWhole, applied.profilesCompact], [1, 1]);
    assert.ok(Number.isInteger(applied.profilesTokens) && applied.profilesTokens > 0);
  });
});

test('buildMemoryRequest: the notes markers count only the lines the request shows, and run stamps nothing it did not flag', async () => {
  const long = notesLines('c1', 20).map((m) => ({ ...m, content: 'λ'.repeat(400) }));
  const channels = { c1: notesChannel('γενικό', { updatedAt: notesDaysAgo(30), days: { [dayOf(0)]: 20 } }) };
  const guildMemory = { patterns: 'μιμίδια', notesUpdatedAt: notesDaysAgo(9) };
  const notes = { notesBatchLines: 20, notesMinMessages: 20, notesGuildMinMessages: 20 };
  const build = (tokens) =>
    buildMemoryRequest({ prompts: { memory: 'sys', labels }, config: budgetConfig(tokens, notes), calibrator: createCalibrator(), profiles: {}, guildMemory, channels, messages: long, selfName: 'Nept', now: NOTES_NOW });

  const cut = build(2500);
  assert.ok(cut.shown > 0 && cut.shown < 20, `a part of the batch is shown (${cut.shown})`);
  assert.equal('stale' in channelsOf(cut).c1, false, 'fewer than memory.notesBatchLines lines shown in the channel');
  assert.equal('stale' in guildOf(cut), false, 'fewer than memory.notesBatchLines lines shown');
  assert.deepEqual(cut.staleNotes, { channels: [], guild: false });

  const whole = build(50000);
  assert.equal(whole.shown, 20);
  assert.deepEqual(channelsOf(whole).c1.stale, { days: 30 });
  assert.deepEqual(whole.staleNotes, { channels: ['c1'], guild: true });

  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    for (const message of long) {
      touchMemory(store, guildId, message);
      store.pushBuffer(guildId, message, 100);
    }
    store.getChannel(guildId, 'c1').updatedAt = notesDaysAgo(30);
    const marked = [];
    store.markNotesChecked = (...args) => marked.push(args);
    const hot = { config: budgetConfig(2500, { ...notes, batchMessages: 20, minBatchMessages: 1 }), prompts: { memory: 'sys', labels } };
    const updater = createMemoryUpdater({ hot, store, llm: recordingLlm({}), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => NOTES_NOW });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));

    const applied = logs.find((entry) => entry.msg === 'memory: update applied');
    assert.ok(applied.deferred > 0, 'the cut batch left lines for the next one');
    assert.equal(applied.notesFlagged, 0);
    assert.deepEqual(marked, [], 'nothing was stamped re-checked');
  });
});

// ---- applyMemoryUpdate: an overflowing rewrite is refused, never cut ---------
// A model answer over a prose field's limit is never cut and stored: on a rewrite the stored text
// stays and the refusal is counted (`overLimit`, `overLimitFields`); only a first write (the field
// was empty, nothing to lose yet) is clamped. Each test sets its own limits.

const PROSE_CFG = { fieldChars: 1000, clampTolerance: 1 };
const PROSE_SENTENCE = 'Μιλάμε για βιβλία και ταξίδια κάθε βράδυ. ';
// About 1200 characters: over fieldChars 1000, relationships.textChars 600 and lore.textChars 600.
const PROSE_OVER = PROSE_SENTENCE.repeat(29).trim();
// About 2400 characters: over the server notes' fieldChars * 2.
const PROSE_OVER_GUILD = `${PROSE_OVER} ${PROSE_OVER}`;

test('applyMemoryUpdate: a channel field over memory.fieldChars keeps the stored text and is counted; a first write is clamped', () => {
  withStore((store) => {
    const guildId = 'g1';
    assert.ok([...PROSE_OVER].length > 1150 && [...PROSE_OVER].length < 1250);
    store.updateChannel(guildId, 'c1', { topics: 'Ένα.' });
    const result = applyMemoryUpdate(store, guildId, { channels: { c1: { topics: PROSE_OVER, purpose: PROSE_OVER } } }, PROSE_CFG, new Set(), {
      knownChannelIds: new Set(['c1']),
    });

    const channel = store.getChannel(guildId, 'c1');
    assert.equal(channel.topics, 'Ένα.', 'the rewrite over the limit is refused whole');
    assert.ok(channel.purpose.length > 0 && [...channel.purpose].length <= 1000, 'the first write is clamped to fieldChars');
    assert.ok(PROSE_OVER.startsWith(channel.purpose));
    assert.equal(result.overLimit, 1);
    assert.deepEqual(result.overLimitFields, ['channels.topics']);
    assert.equal(result.channels, 1, 'the purpose was written');

    const within = PROSE_SENTENCE.repeat(20).trim();
    const again = applyMemoryUpdate(store, guildId, { channels: { c1: { topics: within } } }, PROSE_CFG, new Set(), { knownChannelIds: new Set(['c1']) });
    assert.equal(store.getChannel(guildId, 'c1').topics, within, 'a rewrite within the limit is taken as is');
    assert.equal(again.overLimit, 0);
    assert.deepEqual(again.overLimitFields, []);
  });
});

test('applyMemoryUpdate: relationship, patterns/starters and lore text over their limits keep the stored text', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Zoé', Date.now());
    store.applyProfileOps(guildId, '1', { relationship: 'Φίλοι.', character: 'Ήρεμη.', style: 'Σύντομα.' }, { fieldChars: 1000, relationshipChars: 600 });
    store.updateGuild(guildId, { patterns: 'Ένα.', starters: 'Δύο.' });
    store.setLore(guildId, [{ title: 'Τίτλος', keys: ['κλειδί'], text: 'Παλιό.' }], { source: 'analyzer', textChars: 600 });

    const result = applyMemoryUpdate(
      store,
      guildId,
      {
        users: { 1: { relationship: PROSE_OVER } },
        guild: { patterns: PROSE_OVER_GUILD, starters: PROSE_OVER_GUILD },
        lore: [{ title: 'Τίτλος', keys: ['κλειδί', 'άλλο'], text: PROSE_OVER }],
      },
      PROSE_CFG,
      new Set(['1']),
      { relationshipChars: 600, lore: { enabled: true, maxEntries: 50, textChars: 600, now: Date.now() } },
    );

    const profile = store.getUser(guildId, '1');
    assert.equal(profile.relationship, 'Φίλοι.');
    assert.equal(store.getGuild(guildId).patterns, 'Ένα.');
    assert.equal(store.getGuild(guildId).starters, 'Δύο.');
    const entry = store.getLore(guildId).find((item) => item.title === 'Τίτλος');
    assert.equal(entry.text, 'Παλιό.');
    assert.deepEqual(entry.keys, ['κλειδί', 'άλλο'], 'the keys still change, only the text is refused');
    assert.equal(result.overLimit, 4);
    assert.deepEqual(result.overLimitFields, ['users.relationship', 'lore.text', 'guild.patterns', 'guild.starters']);
    assert.equal(result.relationships, 0);
    assert.equal(result.guild, false);

    // The portrait writers' single-stage character / style: the same rule at fieldChars.
    const portrait = applyMemoryUpdate(store, guildId, { users: { 1: { character: PROSE_OVER, style: 'Μακριές προτάσεις.' } } }, PROSE_CFG, new Set(['1']), {
      portraitFields: true,
    });
    assert.equal(store.getUser(guildId, '1').character, 'Ήρεμη.');
    assert.equal(store.getUser(guildId, '1').style, 'Μακριές προτάσεις.');
    assert.equal(portrait.overLimit, 1);
    assert.deepEqual(portrait.overLimitFields, ['users.character']);
  });
});

test('applyMemoryUpdate: an accepted rewrite records a version with by analyzer', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.updateChannel(guildId, 'c1', { topics: 'Ένα. Δύο.' });
    applyMemoryUpdate(store, guildId, { channels: { c1: { topics: 'Δύο. Τρία.' } } }, PROSE_CFG, new Set(), { knownChannelIds: new Set(['c1']) });

    const versions = store.listVersions(guildId, 'channels', 'c1');
    assert.equal(versions.topics.length, 1);
    assert.equal(versions.topics[0].text, 'Ένα. Δύο.');
    assert.equal(versions.topics[0].by, 'analyzer');

    applyMemoryUpdate(store, guildId, { channels: { c1: { topics: 'Τέσσερα.' } } }, PROSE_CFG, new Set(), {
      knownChannelIds: new Set(['c1']),
      versions: { enabled: false, kept: 20 },
    });
    assert.equal(store.getChannel(guildId, 'c1').topics, 'Τέσσερα.');
    assert.equal(store.listVersions(guildId, 'channels', 'c1').topics.length, 1, 'versions off records nothing');
  });
});

test('run: memory: update applied carries overLimit and overLimitFields', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    for (const message of notesLines('c1', 3)) {
      touchMemory(store, guildId, message);
      store.pushBuffer(guildId, message, 100);
    }
    store.updateChannel(guildId, 'c1', { topics: 'Ένα.' });
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, fieldChars: 1000, clampTolerance: 1, batchMessages: 3, minBatchMessages: 1, versionsKept: 20 } }),
      prompts: { memory: 'sys', labels },
    };
    const llm = { complete: async () => ({ text: JSON.stringify({ channels: { c1: { topics: PROSE_OVER } } }) }) };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => NOTES_NOW });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));
    const applied = logs.find((entry) => entry.msg === 'memory: update applied');
    assert.equal(applied.overLimit, 1);
    assert.deepEqual(applied.overLimitFields, ['channels.topics']);
    assert.equal(store.getChannel(guildId, 'c1').topics, 'Ένα.');
  });
});

test('run: features.versions reaches the store; a rewrite is recorded by the analyzer only while it is on', async () => {
  for (const versions of [false, true]) {
    await withStoreAsync(async (store) => {
      const guildId = 'g1';
      for (const message of notesLines('c1', 3)) {
        touchMemory(store, guildId, message);
        store.pushBuffer(guildId, message, 100);
      }
      store.updateChannel(guildId, 'c1', { topics: 'Ένα.' });
      const hot = {
        config: makeConfig({ features: { versions }, memory: { ...makeConfig().memory, batchMessages: 3, minBatchMessages: 1, versionsKept: 20 } }),
        prompts: { memory: 'sys', labels },
      };
      const llm = { complete: async () => ({ text: JSON.stringify({ channels: { c1: { topics: 'Δύο.' } } }) }) };
      const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => NOTES_NOW });

      await withCapturedLogs(() => updater.run(guildId));
      assert.equal(store.getChannel(guildId, 'c1').topics, 'Δύο.');
      const recorded = store.listVersions(guildId, 'channels', 'c1').topics ?? [];
      assert.deepEqual(recorded.map((v) => v.by), versions ? ['analyzer'] : [], `features.versions ${versions}`);
    });
  }
});

test('applyMemoryUpdate: an identical relationship text renews its stamps and records no version', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Zoé', Date.now());
    const at = (now) => ({ relationshipChars: 600, relationships: { ...RELATIONSHIPS_CFG, now } });
    applyMemoryUpdate(store, guildId, { users: { 1: { relationship: 'Φίλοι.' } } }, PROSE_CFG, new Set(['1']), at(RELATIONSHIPS_CFG.now));
    const result = applyMemoryUpdate(store, guildId, { users: { 1: { relationship: ' Φίλοι. ' } } }, PROSE_CFG, new Set(['1']), at(RELATIONSHIPS_CFG.now + HOUR_MS));

    const profile = store.getUser(guildId, '1');
    assert.equal(profile.relationship, 'Φίλοι.');
    assert.equal(profile.relationshipWrittenAt, new Date(RELATIONSHIPS_CFG.now + HOUR_MS).toISOString(), 'the confirmation renews the stamp');
    assert.equal(result.relationships, 0, 'no text changed');
    assert.equal(result.overLimit, 0);
    assert.deepEqual(store.listVersions(guildId, 'users', '1'), {});
  });
});

// ---- the forced relationship rewrite (`relationshipRewrite`) -----------------

const REWRITE_TEXT = 'Φίλοι από παλιά, μιλούν για βιβλία.';

test('buildMemoryRequest: a flagged profile with a text goes with relationshipStale cause rewrite, the flag itself is never shown', () => {
  const profile = { relationship: REWRITE_TEXT, relationshipScore: 30, relationshipRewrite: true, affinity: { score: 30, reason: 'φίλοι', history: [] } };
  const view = profilesViewOf(profile);
  assert.deepEqual(view.relationshipStale, { writtenAt: 'fond', now: 'fond', cause: 'rewrite' });
  assert.equal('relationshipRewrite' in view, false);

  const config = makeConfig({ features: { relationships: true }, relationships: RELATIONSHIP_STALE_PIN });
  const request = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator: createCalibrator(),
    profiles: { 1: { names: ['nick'], ...profile }, 2: { names: ['zoé'], relationship: REWRITE_TEXT, relationshipScore: 30, affinity: { score: 30, reason: '', history: [] } } },
    guildMemory: {},
    messages: [slimMessage({ id: 'm1', authorId: '1' }), slimMessage({ id: 'm2', authorId: '2' })],
    selfName: 'Nept',
  });
  assert.equal(request.relationshipRewrites, 1);
  assert.deepEqual(request.rewriteIds, ['1']);
  assert.equal(request.staleRelationships, 1);
});

test('buildMemoryRequest: a private batch never sends cause rewrite', () => {
  const profile = { relationship: REWRITE_TEXT, relationshipScore: 30, relationshipRewrite: true, affinity: { score: 30, reason: '', history: [] } };
  const view = profilesViewOf(profile, {}, { publicProfile: { id: '1', names: ['nick'], interests: [], details: [], aliases: [] }, now: Date.UTC(2026, 0, 1, 12) });
  assert.equal(view.relationshipStale, undefined);
});

/** A guild with member '1' whose relationship text is flagged for a rewrite, and one buffered line of theirs. */
function seedRewrite(store, guildId, at) {
  store.touchUser(guildId, '1', 'Aria', at - 60_000);
  store.applyProfileOps(guildId, '1', { relationship: REWRITE_TEXT }, { fieldChars: 400, relationshipScore: 0, now: at - DAY_MS });
  assert.equal(store.markRelationshipRewrite(guildId, '1'), true);
  store.pushBuffer(guildId, slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: at - 1000 }), 100);
}

test('run (two-stage): a rewrite member with an empty brief still gets a voice item with rewrite and old; unanswered, the flag stays', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    seedRewrite(store, guildId, VOICE_AT);
    const hot = voiceHot({ batchMessages: 1, minBatchMessages: 1 });
    const llm = voiceLlm({ decision: { users: { 1: { relationship: '' } } } });

    const { logs } = await withCapturedLogs(() => voiceUpdater(store, hot, llm).run(guildId));

    const stageA = JSON.parse(blockBody(llm.calls[0].messages[1].content, 'existing_profiles'));
    assert.equal(stageA['1'].relationshipStale.cause, 'rewrite');
    assert.equal(llm.voiceCalls().length, 1);
    const [sent] = voiceItemsOf(llm.voiceCalls()[0].messages);
    assert.deepEqual(
      { kind: sent.kind, old: sent.old, rewrite: sent.rewrite, brief: sent.brief },
      { kind: 'relationship', old: REWRITE_TEXT, rewrite: true, brief: [] },
    );
    const [queued, ...rest] = store.getVoiceQueue(guildId);
    assert.deepEqual(rest, []);
    assert.deepEqual({ kind: queued.kind, userId: queued.userId, rewrite: queued.rewrite, brief: queued.brief }, { kind: 'relationship', userId: '1', rewrite: true, brief: [] });
    assert.equal(store.getUser(guildId, '1').relationship, REWRITE_TEXT);
    assert.equal(store.getUser(guildId, '1').relationshipRewrite, true, 'nothing written: the flag stays');
    assert.equal(logs.find((entry) => entry.msg === 'memory: update applied').relationshipRewrites, 1);
  });
});

test('run (two-stage): the voice apply writes the rewritten text and clears the flag', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    seedRewrite(store, guildId, VOICE_AT);
    const hot = voiceHot({ batchMessages: 1, minBatchMessages: 1 });
    const llm = voiceLlm({ decision: { users: {} }, word: (item) => (item.kind === 'relationship' && item.rewrite === true ? 'Παλιοί φίλοι που μιλούν για βιβλία.' : null) });

    await withCapturedLogs(() => voiceUpdater(store, hot, llm).run(guildId));

    const profile = store.getUser(guildId, '1');
    assert.equal(profile.relationship, 'Παλιοί φίλοι που μιλούν για βιβλία.');
    assert.equal(profile.relationshipRewrite, undefined);
    assert.equal(profile.relationshipWrittenAt, new Date(VOICE_AT).toISOString());
    assert.deepEqual(store.getVoiceQueue(guildId), []);
  });
});

test('run (single-stage): a rewrite member answered with no text keeps the flag; a written text clears it', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const at = Date.UTC(2026, 0, 9, 12);
    seedRewrite(store, guildId, at);
    let answer = { users: { 1: { relationship: '' } } };
    const memory = { ...makeConfig().memory, batchMessages: 1, minBatchMessages: 1 };
    const hot = { config: makeConfig({ memory, features: { relationships: true }, relationships: { ...RELATIONSHIP_STALE_PIN, textChars: 600 } }), prompts: { memory: 'sys', labels } };
    const llm = recordingLlm({});
    llm.complete = async (messages, options) => {
      llm.calls.push({ messages, options });
      return { text: JSON.stringify(answer) };
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => at });

    const first = await withCapturedLogs(() => updater.run(guildId));
    assert.equal(JSON.parse(blockBody(llm.calls[0].messages[1].content, 'existing_profiles'))['1'].relationshipStale.cause, 'rewrite');
    assert.equal(first.logs.find((entry) => entry.msg === 'memory: update applied').relationshipRewrites, 1);
    assert.equal(store.getUser(guildId, '1').relationship, REWRITE_TEXT);
    assert.equal(store.getUser(guildId, '1').relationshipRewrite, true, 'the next batch flags it again');

    answer = { users: { 1: { relationship: 'Παλιοί φίλοι που μιλούν για βιβλία.' } } };
    store.pushBuffer(guildId, slimMessage({ id: 'm2', authorId: '1', authorName: 'Aria', ts: at - 500 }), 100);
    await withCapturedLogs(() => updater.run(guildId));
    assert.equal(JSON.parse(blockBody(llm.calls[1].messages[1].content, 'existing_profiles'))['1'].relationshipStale.cause, 'rewrite');
    assert.equal(store.getUser(guildId, '1').relationship, 'Παλιοί φίλοι που μιλούν για βιβλία.');
    assert.equal(store.getUser(guildId, '1').relationshipRewrite, undefined);
  });
});

// ---- the record (src/memory/record.js) ---------------------------------------

test('memory update: a failing record append keeps the batch in the buffer and skips analysis', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const base = Date.UTC(2026, 9, 11, 12, 0, 0);
    store.pushBuffer(guildId, slimMessage({ id: 'm1', ts: base, mentionedUserIds: ['2'] }), 100);
    store.pushBuffer(guildId, slimMessage({ id: 'm2', authorId: '2', authorName: 'other', ts: base + 1000, replyToId: 'm1' }), 100);
    const before = structuredClone(store.getBuffer(guildId));
    const config = makeConfig({ memory: { ...makeConfig().memory, batchMessages: 2, minBatchMessages: 1 } });
    config.features = { ...(config.features ?? {}), record: true };
    const hot = { config, prompts: { memory: 'sys', labels } };
    let llmCalls = 0;
    const llm = { complete: async () => { llmCalls += 1; return { text: '{}' }; } };
    const appended = [];
    let fail = true;
    const record = {
      append: async (gid, lines, opts) => {
        appended.push({ gid, lines, opts });
        if (fail) throw Object.assign(new Error('disk refused'), { code: 'append-stalled' });
        return { written: lines.length, duplicates: 0 };
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => base + 60_000, record });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));
    assert.equal(llmCalls, 0, 'nothing is analyzed');
    assert.deepEqual(store.getBuffer(guildId), before, 'the batch stays in the buffer');
    const failed = logs.find((entry) => entry.msg === 'memory: record failed');
    assert.ok(failed, 'memory: record failed is logged');
    assert.equal(failed.lines, 2);
    assert.equal(failed.code, 'append-stalled');
    assert.equal(JSON.stringify(failed).includes('hello'), false, 'counts only, never the text');
    assert.deepEqual(appended[0].lines.map((line) => [line.kind, line.messageId]), [['seen', 'm1'], ['seen', 'm2']]);
    assert.deepEqual(appended[0].lines[0].mentions, ['2']);
    assert.deepEqual(appended[0].lines[1].participants, ['2', '1'], 'the reply target author from the buffer');

    // The next run retries: the append succeeds, then the batch is analyzed and consumed.
    fail = false;
    await withCapturedLogs(() => updater.run(guildId));
    assert.equal(appended.length, 2, 'the same batch is appended again');
    assert.equal(llmCalls, 1);
    assert.deepEqual(store.getBuffer(guildId), []);

    // features.record off (read at use): nothing is appended.
    hot.config.features.record = false;
    store.pushBuffer(guildId, slimMessage({ id: 'm3', ts: base + 2000 }), 100);
    await withCapturedLogs(() => updater.run(guildId));
    assert.equal(appended.length, 2);
  });
});

// ---- the journal: memory records, limits, a stalled append store ------------
// With features.journal on, every applied batch writes one `memory` record (src/memory/journal.js)
// built from what the store holds after the apply; a stalled append store pauses the batches.

/** A journal stand-in: the memory records it was given, and a stalled switch. */
function fakeJournal() {
  const records = [];
  return {
    records,
    stalledNow: false,
    memory: async (guildId, record) => {
      records.push({ guildId, record });
    },
    stalled() {
      return this.stalledNow;
    },
  };
}

const sha12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/** A journalled hot view: features.journal on, attitude and episodes kept, fixed hashes. */
function journalHot(memoryOverrides = {}) {
  return {
    config: makeConfig({
      features: { journal: true },
      relationships: { maxDelta: 10, historySize: 10, textChars: 600 },
      memory: { ...makeConfig().memory, batchMessages: 3, minBatchMessages: 1, maxEpisodes: 10, maxNewEpisodes: 3, clampTolerance: 1, ...memoryOverrides },
    }),
    prompts: { memory: 'sys', labels },
    hashes: { promptsHash: 'a'.repeat(16), configHash: 'b'.repeat(16) },
  };
}

test('memory update: writes a journal memory record with batch ids, changed users, episode keys and attitude moves from the applied result', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    for (const message of notesLines('c1', 3)) {
      touchMemory(store, guildId, message);
      store.pushBuffer(guildId, message, 100);
    }
    const answer = {
      users: {
        1: {
          relationship: 'Φίλοι από παλιά.',
          affinity: { delta: 4, reason: 'βοήθησε με το ταξίδι' },
          episodes: [{ date: '2026-01-20', what: 'Μίλησε για το ταξίδι στη Λισαβόνα.', weight: 3 }],
        },
      },
      guild: { learned: { add: ['Το τσάι του βουνού θέλει πέντε λεπτά.'] } },
    };
    const journal = fakeJournal();
    let n = 0;
    const hot = journalHot();
    const updater = createMemoryUpdater({
      hot,
      store,
      llm: { complete: async () => ({ text: JSON.stringify(answer) }) },
      calibrator: createCalibrator(),
      getSelfName: () => 'Nept',
      now: () => NOTES_NOW,
      journal,
      uuid: () => `u${(n += 1)}`,
    });

    await withCapturedLogs(() => updater.run(guildId));

    assert.equal(journal.records.length, 1);
    const [{ guildId: written, record }] = journal.records;
    assert.equal(written, guildId);
    assert.equal(record.batchId, 'b-u1', 'allotted when the batch was taken');
    assert.equal(record.appliedRevision, 'r-u2');
    assert.equal(record.stage, 'single');
    assert.deepEqual(record.batch, { messageIds: ['c1-0', 'c1-1', 'c1-2'], consumed: 3 });
    assert.deepEqual(record.sourceMessageIds, ['c1-0', 'c1-1', 'c1-2']);
    assert.deepEqual(record.changed, { users: ['1'], guild: true, channels: [], lore: 0 });
    const what = 'Μίλησε για το ταξίδι στη Λισαβόνα.';
    assert.equal(record.episodes.length, 1);
    assert.match(record.episodes[0].itemId, /^ep-/, 'the stored episode carries its itemId');
    assert.deepEqual(record.episodes.map(({ itemId, ...rest }) => rest), [{ userId: '1', key: sha12(`2026-01-20|${what}`), what, weight: 3 }]);
    assert.deepEqual(record.attitude, [{ userId: '1', delta: 4, applied: 4, reason: 'βοήθησε με το ταξίδι' }]);
    const [learned] = store.getGuild(guildId).learned;
    assert.deepEqual(record.learned, [{ id: learned.id, text: 'Το τσάι του βουνού θέλει πέντε λεπτά.' }]);
    assert.deepEqual(record.self, []);
    assert.deepEqual([record.consolidation, record.archived, record.limits], [[], [], []]);
    assert.deepEqual([record.promptsHash, record.configHash], ['a'.repeat(16), 'b'.repeat(16)]);
    assert.deepEqual(record.participants, ['1']);
    assert.equal(record.privateUserId ?? null, null);

    // The switch off (read at the moment of use): nothing is written.
    hot.config.features.journal = false;
    for (const message of notesLines('c2', 3)) store.pushBuffer(guildId, message, 100);
    await withCapturedLogs(() => updater.run(guildId));
    assert.equal(journal.records.length, 1);
  });
});

test('memory update: a private batch writes its memory record to the private journal of the partner', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const journal = fakeJournal();
    const hot = journalHot();
    const answer = { users: { u1: { episodes: [{ date: '2026-01-20', what: 'Είπε ένα μυστικό.', weight: 2 }] } } };
    const updater = createMemoryUpdater({ hot, store, llm: { complete: async () => ({ text: JSON.stringify(answer) }) }, calibrator: createCalibrator(), getSelfName: () => 'Nept', journal });
    for (let i = 0; i < 2; i += 1) updater.observe(guildId, dmMessage({ id: `d${i}`, ts: Date.now() - 60_000 + i * 1000 }), { private: 'u1' });

    await withCapturedLogs(() => updater.runPrivate(guildId, 'u1'));

    assert.equal(journal.records.length, 1);
    const { record } = journal.records[0];
    assert.equal(record.privateUserId, 'u1', 'src/memory/journal.js writes it to the private day file');
    assert.deepEqual(record.batch.messageIds, ['d0', 'd1']);
    assert.deepEqual(record.changed.users, ['u1']);
    assert.deepEqual(record.episodes.map((ep) => [ep.userId, ep.what]), [['u1', 'Είπε ένα μυστικό.']]);
    assert.equal(store.getUser(guildId, 'u1'), null, 'nothing reached the public profile');
  });
});

test('memory update: over-limit refusals and clamps appear in limits', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    for (const message of notesLines('c1', 3)) {
      touchMemory(store, guildId, message);
      store.pushBuffer(guildId, message, 100);
    }
    store.updateChannel(guildId, 'c1', { topics: 'Ένα.' });
    const answer = { users: { 1: { relationship: PROSE_OVER } }, channels: { c1: { topics: PROSE_OVER } } };
    const journal = fakeJournal();
    const updater = createMemoryUpdater({
      hot: journalHot({ fieldChars: 1000 }),
      store,
      llm: { complete: async () => ({ text: JSON.stringify(answer) }) },
      calibrator: createCalibrator(),
      getSelfName: () => 'Nept',
      now: () => NOTES_NOW,
      journal,
    });

    await withCapturedLogs(() => updater.run(guildId));

    const { record } = journal.records[0];
    const stored = store.getUser(guildId, '1').relationship;
    assert.ok([...stored].length <= 600, 'the first relationship write was clamped');
    assert.deepEqual(record.limits, [
      { kind: 'clamp', where: 'users.relationship', lost: [...PROSE_OVER].length - [...stored].length },
      { kind: 'over-limit', where: 'channels.topics', lost: [...PROSE_OVER].length - 1000 },
    ]);
    assert.equal(store.getChannel(guildId, 'c1').topics, 'Ένα.');
  });
});

test('memory update: a stalled append store pauses application and keeps the batch', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    for (const message of notesLines('c1', 3)) {
      touchMemory(store, guildId, message);
      store.pushBuffer(guildId, message, 100);
    }
    const journal = fakeJournal();
    journal.stalledNow = true;
    let calls = 0;
    const updater = createMemoryUpdater({
      hot: journalHot(),
      store,
      llm: {
        complete: async () => {
          calls += 1;
          return { text: '{}' };
        },
      },
      calibrator: createCalibrator(),
      getSelfName: () => 'Nept',
      now: () => NOTES_NOW,
      journal,
    });

    const { logs } = await withCapturedLogs(async () => {
      await updater.run(guildId);
      await updater.run(guildId);
    });
    assert.equal(calls, 0, 'nothing sent');
    assert.deepEqual(store.getBuffer(guildId).map((m) => m.id), ['c1-0', 'c1-1', 'c1-2'], 'the batch stays in the buffer');
    const paused = logs.filter((entry) => entry.msg === 'memory: paused');
    assert.equal(paused.length, 1, 'once per streak');
    assert.deepEqual([paused[0].level, paused[0].reason, paused[0].guildId], ['warn', 'append-stalled', guildId]);
    assert.equal(journal.records.length, 0);

    // The disk answers again: the batch is applied, and the next streak is logged again.
    journal.stalledNow = false;
    await withCapturedLogs(() => updater.run(guildId));
    assert.equal(calls, 1);
    assert.deepEqual(store.getBuffer(guildId), []);
    assert.equal(journal.records.length, 1);
    journal.stalledNow = true;
    for (const message of notesLines('c2', 3)) store.pushBuffer(guildId, message, 100);
    const again = await withCapturedLogs(() => updater.run(guildId));
    assert.equal(again.logs.filter((entry) => entry.msg === 'memory: paused').length, 1);
  });
});

test('memory update: a two-stage batch writes its stage two record, then the voice writes their own record', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now() - 60_000);
    store.pushBuffer(guildId, slimMessage({ id: 'm1', authorId: '1', authorName: 'Aria', ts: Date.now() - 1000 }), 100);
    const hot = voiceHot({ batchMessages: 1, minBatchMessages: 1 }, { relationships: { damping: false, maxDelta: 10, historySize: 10 } });
    hot.config.features.journal = true;
    const texts = { relationship: 'φίλοι από το παζλ', reason: 'με βοήθησε στο δύσκολο σημείο', feeling: 'χάρηκα πολύ' };
    const llm = voiceLlm({
      decision: { users: { 1: { relationship: 'έγιναν φίλοι', affinity: { delta: 4, event: 'τη βοήθησε' }, episodes: [{ what: 'έλυσαν ένα παζλ', tone: 'χαρά' }] } } },
      word: (item) => texts[item.kind],
    });
    const journal = fakeJournal();
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', journal });

    await withCapturedLogs(() => updater.run(guildId));

    assert.deepEqual(journal.records.map(({ record }) => record.stage), ['two', 'voice']);
    const [batch, voice] = journal.records.map(({ record }) => record);
    assert.deepEqual(batch.batch.messageIds, ['m1']);
    assert.deepEqual(batch.changed.users, ['1']);
    assert.deepEqual(batch.attitude.map((move) => [move.userId, move.applied]), [['1', 4]]);
    assert.deepEqual(batch.episodes.map((ep) => [ep.userId, ep.what, ep.itemId.startsWith('ep-')]), [['1', 'έλυσαν ένα παζλ', true]]);
    assert.notEqual(voice.batchId, batch.batchId);
    assert.deepEqual(voice.batch, { messageIds: [], consumed: 0 });
    assert.deepEqual(voice.changed.users, ['1'], 'the worded relationship, reason and feeling');
    assert.equal(store.getUser(guildId, '1').relationship, 'φίλοι από το παζλ');
    assert.deepEqual(voice.participants, ['1']);
  });
});

// ---- the archive: a stalled pending queue pauses application; the record lists confirmed copies ----

test('memory update: pending above pendingMax pauses application with the batch retained and logs memory: archive stalled', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    for (const message of notesLines('c1', 3)) {
      touchMemory(store, guildId, message);
      store.pushBuffer(guildId, message, 100);
    }
    const hot = journalHot();
    hot.config.features = { ...hot.config.features, archive: true };
    hot.config.archive = { pendingMax: 500, drainMs: 30000 };
    let pending = 501;
    const archive = { stats: (id) => (id === guildId ? { pending } : { pending: 0 }) };
    const notices = [];
    let calls = 0;
    const updater = createMemoryUpdater({
      hot,
      store,
      llm: {
        complete: async () => {
          calls += 1;
          return { text: '{}' };
        },
      },
      calibrator: createCalibrator(),
      getSelfName: () => 'Nept',
      now: () => NOTES_NOW,
      journal: fakeJournal(),
      archive,
      notify: async (text) => {
        notices.push(text);
      },
    });

    const { logs } = await withCapturedLogs(async () => {
      await updater.run(guildId);
      await updater.run(guildId);
    });
    assert.equal(calls, 0, 'nothing sent');
    assert.deepEqual(store.getBuffer(guildId).map((m) => m.id), ['c1-0', 'c1-1', 'c1-2'], 'the batch stays in the buffer');
    const stalled = logs.filter((entry) => entry.msg === 'memory: archive stalled');
    assert.equal(stalled.length, 1, 'once per streak');
    assert.deepEqual([stalled[0].level, stalled[0].guildId, stalled[0].pending, stalled[0].pendingMax], ['warn', guildId, 501, 500]);
    assert.equal(notices.length, 1, 'the development channel hears it once');
    assert.match(notices[0], /memory: archive stalled/);

    // pendingMax is read at the moment of use; at or under it the batch is applied.
    hot.config.archive.pendingMax = 501;
    await withCapturedLogs(() => updater.run(guildId));
    assert.equal(calls, 1);
    assert.deepEqual(store.getBuffer(guildId), []);

    // features.archive off: the queue does not pause anything.
    hot.config.archive.pendingMax = 500;
    pending = 900;
    hot.config.features.archive = false;
    for (const message of notesLines('c2', 3)) store.pushBuffer(guildId, message, 100);
    await withCapturedLogs(() => updater.run(guildId));
    assert.equal(calls, 2);
  });
});

test('memory update: the journal memory record lists only confirmed archive ids', async () => {
  const dir = tempDir();
  try {
    const appended = [];
    const queued = [];
    const archive = {
      fail: false,
      async append(guildId, entries) {
        if (archive.fail) throw Object.assign(new Error('disk refused'), { code: 'archive-unconfirmed' });
        appended.push(...entries);
        return { written: entries.length, duplicates: 0 };
      },
      async queuePending(guildId, entries) {
        queued.push(...entries);
        return entries.length;
      },
      stats: () => ({ pending: queued.length }),
    };
    const store = createStore({ dataDir: dir, archive });
    const guildId = 'g1';
    const hot = journalHot({ maxEpisodes: 1 });
    hot.config.features = { ...hot.config.features, archive: true };
    hot.config.archive = { pendingMax: 500, drainMs: 30000 };
    const lines = (channelId) => {
      for (const message of notesLines(channelId, 3)) {
        touchMemory(store, guildId, message);
        store.pushBuffer(guildId, message, 100);
      }
    };
    lines('c1');
    store.addEpisodes(guildId, '1', [{ date: '2026-01-10', what: 'Μια παλιά στιγμή.', weight: 1 }], { maxEpisodes: 1, maxNew: 3, now: NOTES_NOW - DAY_MS });
    const [old] = store.getUser(guildId, '1').episodes;
    const answers = [
      { users: { 1: { episodes: [{ date: '2026-01-20', what: 'Μια νέα στιγμή.', weight: 3 }] } } },
      { users: { 1: { episodes: [{ date: '2026-01-20', what: 'Μια τρίτη στιγμή.', weight: 3 }] } } },
    ];
    const journal = fakeJournal();
    const updater = createMemoryUpdater({
      hot,
      store,
      llm: { complete: async () => ({ text: JSON.stringify(answers.shift()) }) },
      calibrator: createCalibrator(),
      getSelfName: () => 'Nept',
      now: () => NOTES_NOW,
      journal,
      archive,
    });

    await withCapturedLogs(() => updater.run(guildId));
    assert.deepEqual(appended.map((entry) => [entry.itemKind, entry.event, entry.itemId]), [['episode', 'evicted', old.itemId]]);
    assert.deepEqual(journal.records[0].record.archived, [{ itemId: old.itemId, revisionId: appended[0].revisionId, confirmed: true }]);
    assert.deepEqual(store.getUser(guildId, '1').episodes.map((ep) => ep.what), ['Μια νέα στιγμή.'], 'trimmed once confirmed');

    // The archive refuses: the victim stays hot, the record lists nothing, the deferral is logged.
    archive.fail = true;
    lines('c2');
    const { logs } = await withCapturedLogs(() => updater.run(guildId));
    assert.equal(journal.records.length, 2);
    assert.deepEqual(journal.records[1].record.archived, []);
    assert.equal(queued.length, 1);
    assert.deepEqual(store.getUser(guildId, '1').episodes.map((ep) => ep.what), ['Μια νέα στιγμή.', 'Μια τρίτη στιγμή.']);
    const deferred = logs.find((entry) => entry.msg === 'memory: archive deferred');
    assert.ok(deferred, 'memory: archive deferred is logged');
    assert.deepEqual([deferred.guildId, deferred.deferred, deferred.archived], [guildId, 1, 0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- validity: closed claims and supersedes / conflict ops ---------------------

test('memory update: existing_profiles lists closed claims of the batch\'s topics', () => {
  const messages = [slimMessage({ id: 'm1', content: 'Anyone up for chess tonight? Vex says hi', ts: Date.UTC(2026, 9, 1, 12, 0, 0) })];
  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config: makeConfig(),
    calibrator: createCalibrator(),
    profiles: {
      1: {
        names: ['nick'],
        interests: [{ topic: 'Go', note: 'plays', weight: 1, firstSeen: '2026-09-20T00:00:00.000Z', lastSeen: null, itemId: 'in-b' }],
        details: [],
        aliases: [{ name: 'Vertex', weight: 1, itemId: 'al-b' }],
        closed: [
          { kind: 'interest', topic: 'Chess', note: 'played', weight: 3, firstSeen: '2026-01-02T00:00:00.000Z', itemId: 'in-a', validFrom: '2026-01-01', validTo: '2026-09-20', supersededBy: 'in-b' },
          { kind: 'interest', topic: 'Chessboxing', note: '', weight: 1, firstSeen: '2026-01-02T00:00:00.000Z', itemId: 'in-c', validTo: '2026-09-20' },
          { kind: 'detail', id: 4, text: 'lives in Lyon', weight: 1, firstSeen: '2026-03-01T00:00:00.000Z', itemId: 'dt-a', validTo: '2026-09-01' },
          { kind: 'alias', name: 'Vex', weight: 1, firstSeen: '2026-02-01T00:00:00.000Z', itemId: 'al-a', validTo: '2026-09-15' },
        ],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });
  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].closed, [
    { kind: 'interest', topic: 'Chess', note: 'played', from: '2026-01-01', to: '2026-09-20' },
    { kind: 'alias', name: 'Vex', from: '2026-02-01', to: '2026-09-15' },
  ]);
  assert.deepEqual(profiles['1'].interests, [{ itemId: 'in-b', topic: 'Go', note: 'plays', seen: 1 }], 'open items carry the itemId an op names');
});

test('memory update: supersedes and conflict ops reach the store', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    applyMemoryUpdate(store, guildId, { users: { 1: { interests: { add: [{ topic: 'Chess', note: 'plays' }] }, details: { add: ['lives in Lyon'] }, aliases: { add: ['Vex'] } } } }, MEMORY_CFG, new Set(['1']));
    const before = store.getUser(guildId, '1');
    const chessId = before.interests[0].itemId;
    const lyonId = before.details[0].itemId;
    assert.ok(chessId && lyonId);

    const result = applyMemoryUpdate(
      store,
      guildId,
      {
        users: {
          1: {
            interests: { add: [{ topic: 'Go', note: 'plays', supersedes: chessId, validFrom: '2026-09-20' }] },
            details: { add: [{ text: 'lives in Nice', conflict: lyonId }] },
            aliases: { add: [{ name: 'Vertex', supersedes: 'Vex' }] },
          },
        },
      },
      MEMORY_CFG,
      new Set(['1']),
    );
    assert.equal(result.interestsChanged, 1);
    const profile = store.getUser(guildId, '1');
    assert.deepEqual(profile.interests.map((item) => item.topic), ['Go']);
    assert.deepEqual(profile.aliases.map((item) => item.name), ['Vertex']);
    const closed = profile.closed.map((item) => [item.kind, item.topic ?? item.name, item.validTo, item.supersededBy]);
    assert.deepEqual(closed[0], ['interest', 'Chess', '2026-09-20', profile.interests[0].itemId]);
    assert.equal(closed[1][0], 'alias');
    assert.equal(closed[1][1], 'Vex');
    assert.equal(closed[1][3], profile.aliases[0].itemId);
    assert.deepEqual(profile.details.map((item) => [item.text, item.conflictSetId]), [['lives in Lyon', lyonId], ['lives in Nice', lyonId]]);
  });
});

// ---- the real name and the names people use ----

test('buildMemoryRequest: a whole profile shows realName as its name and addressedAs as names, most used first', () => {
  const at = Date.UTC(2026, 0, 1, 12, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config: makeConfig({ memory: { ...makeConfig().memory, addressHalfLifeDays: 30 } }),
    calibrator: createCalibrator(),
    profiles: {
      1: {
        names: ['nick'],
        character: '',
        interests: [],
        style: '',
        details: [],
        relationship: '',
        realName: { name: 'Théo', from: '2025-12-01', to: null, itemId: 'rn-1' },
        // Léo's 4 uses are 60 days old (worth 1 now): Nikos's 2 recent ones rank first.
        addressedAs: { 'Léo': { score: 4, last: iso(at - 60 * DAY_MS) }, Nikos: { score: 2, last: iso(at) }, Sus: { score: 0.5, last: iso(at) } },
      },
      2: { names: ['other'], character: '', interests: [], style: '', details: [], relationship: '' },
    },
    guildMemory: {},
    messages: [slimMessage({ id: 'm1', ts: at })],
    selfName: 'Nept',
    now: at,
  });
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(llmMessages[1].content)[1]);
  assert.equal(profiles['1'].realName, 'Théo');
  assert.deepEqual(profiles['1'].addressedAs, ['Nikos', 'Léo', 'Sus']);
  assert.equal('realName' in profiles['2'], false);
  assert.equal('addressedAs' in profiles['2'], false);
});

test('memory update: realName reaches the store as a string or an object; a member reference or a roster member\'s is dropped', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.touchUser(guildId, '2', 'other', Date.now());
    applyMemoryUpdate(store, guildId, { users: { 1: { realName: 'Théo' }, 2: { realName: 'Ilias' } } }, MEMORY_CFG, new Set(['1']), { aliasOnlyIds: new Set(['2']) });
    const first = store.getUser(guildId, '1').realName;
    assert.equal(first.name, 'Théo');
    assert.equal(store.getUser(guildId, '2').realName, undefined, 'a roster member gets aliases only');

    applyMemoryUpdate(store, guildId, { users: { 1: { realName: 'nick (id:123456789012345678)' } } }, MEMORY_CFG, new Set(['1']));
    assert.deepEqual(store.getUser(guildId, '1').realName, first);

    applyMemoryUpdate(store, guildId, { users: { 1: { realName: { name: 'Léon', supersedes: first.itemId } } } }, MEMORY_CFG, new Set(['1']));
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.realName.name, 'Léon');
    assert.deepEqual(profile.closed.map((item) => [item.kind, item.name, item.supersededBy]), [['realName', 'Théo', profile.realName.itemId]]);
  });
});

test('run: a consumed batch counts the names its lines call other members by, never the author\'s own', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const base = Date.UTC(2026, 0, 9, 12);
    store.touchUser(guildId, '1', 'Aria', base - DAY_MS);
    store.touchUser(guildId, '2', 'Βράνος', base - DAY_MS);
    const lines = [
      { id: 'm0', authorId: '1', authorName: 'Aria', content: 'hi Βράνο, see https://example.com/aria' },
      { id: 'm1', authorId: '2', authorName: 'Βράνος', content: 'Βράνος is back' },
      { id: 'm2', authorId: '999', authorName: 'Nept', self: true, content: 'Aria, welcome back' },
    ];
    lines.forEach((line, i) => store.pushBuffer(guildId, slimMessage({ ...line, ts: base + i * MINUTE_MS }), 100));
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 3, minBatchMessages: 1, addressHalfLifeDays: 30 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const llm = { complete: async () => ({ text: JSON.stringify({ users: {} }) }) };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => base + HOUR_MS });

    const { logs } = await withCapturedLogs(() => updater.run(guildId));
    const applied = logs.find((entry) => entry.msg === 'memory: update applied');
    assert.equal(applied.addressUses, 2);
    assert.deepEqual(store.getUser(guildId, '2').addressedAs, { 'Βράνος': { score: 1, last: new Date(base).toISOString() } });
    assert.deepEqual(store.getUser(guildId, '1').addressedAs, { Aria: { score: 1, last: new Date(base + 2 * MINUTE_MS).toISOString() } }, 'the persona\'s line counts, the URL does not');
  });
});

test('analyze: with features.intentions on, a guild batch asks for candidates (memory-intentions appended) and hands the answer and its lines on', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const answer = { intentions: [{ span: 'θα το φέρω', purpose: 'bring it' }] };
    const llm = recordingLlm(answer);
    const handed = [];
    const prompts = { memory: 'sys', 'memory-intentions': 'CANDIDATES at most {{maxCandidates}}', labels };
    const hot = { config: makeConfig({ features: { intentions: true }, intentions: { maxCandidates: 3 } }), prompts };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', onIntentionCandidates: (...args) => handed.push(args) });
    const lines = [slimMessage({ id: 'm1' }), slimMessage({ id: 'm2', self: true, authorId: 'bot', content: 'θα το φέρω' })];
    await withCapturedLogs(() => updater.analyze(guildId, lines));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(llm.calls[0].messages[0].content, 'sys\n\nCANDIDATES at most 3');
    assert.equal(handed.length, 1);
    assert.equal(handed[0][0], guildId);
    assert.deepEqual(handed[0][1], answer.intentions);
    assert.deepEqual(handed[0][2].map((m) => m.id), ['m1', 'm2']);

    // Off: the system message as it was, nothing handed on even when the model answers the field.
    hot.config.features.intentions = false;
    await withCapturedLogs(() => updater.analyze(guildId, [slimMessage({ id: 'm3' })]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(llm.calls[1].messages[0].content, 'sys');
    assert.equal(handed.length, 1);
  });
});
