// Tests for src/memory/voice.js: the pure core of the two-stage analyzer's voice queue --
// splitting a stage A decision into its neutral part and voice items, the queue operations
// (merge, due, retry, expiry, removal), the stage B request and answer, the write plan and the
// degraded path. Pure, no I/O: config.json is read only to compare the code fallbacks with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VOICE_KINDS,
  REASON_CHARS,
  FEELING_CHARS,
  SELF_CHARS,
  voiceSettings,
  voiceLimits,
  normalizeQueue,
  splitDecision,
  mergeIntoQueue,
  dueItems,
  retryDelayMs,
  retryLater,
  expireItems,
  removeItems,
  forgetMember,
  buildVoiceRequest,
  buildVoiceRetry,
  parseVoiceAnswer,
  applyVoiceItems,
  degradedApply,
} from '../src/memory/voice.js';
import { characterText, applyMemoryUpdate, MEMORY_LIMIT_DEFAULTS } from '../src/memory/update.js';
import { applyDelta } from '../src/memory/affinity.js';
import { mergeEpisodes } from '../src/memory/episodes.js';
import { createCalibrator } from '../src/llm/tokens.js';
import { SectionsTooLargeError } from '../src/llm/budget.js';
import { toTokens } from '../src/memory/mentions.js';
import { HOUR_MS, MINUTE_MS } from '../src/time.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readTracked = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const NOW_ISO = new Date(NOW).toISOString();
const TODAY = NOW_ISO.slice(0, 10);

const ELENI = '111111111111111111';
const NIKOS = '222222222222222222';
const ZOE = '333333333333333333';
const NAMES = { [ELENI]: 'Ελένη', [NIKOS]: 'Νίκος', [ZOE]: 'Zoë' };
const nameOf = (id) => NAMES[id] ?? null;
const isKnownId = (id) => Object.hasOwn(NAMES, id);
const tokenize = (text) => toTokens(text, isKnownId, (id) => (NAMES[id] ? [NAMES[id]] : []));

function makeConfig(overrides = {}) {
  return {
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
    features: {},
    memory: {
      fieldChars: 1000,
      learnedChars: 160,
      maxNewEpisodes: 3,
      clampTolerance: 1.25,
      voice: { maxItems: 24, maxOutputTokens: 3000, retryMinutes: 15, maxAttempts: 4, queueMax: 100, queueHours: 24 },
    },
    relationships: { textChars: 600 },
    ...overrides,
  };
}

function withVoice(voice) {
  const config = makeConfig();
  config.memory.voice = { ...config.memory.voice, ...voice };
  return config;
}

/** One queued item of `kind` (what splitDecision would hand mergeIntoQueue), queued at `at`. */
function item(kind, fields = {}, at = NOW) {
  return { kind, brief: ['σημείωση'], createdAt: at, attempts: 0, misses: 0, nextAt: at, ...fields };
}

function queueOf(items, nowMs = NOW, config = makeConfig()) {
  return mergeIntoQueue([], items, nowMs, config).queue;
}

const PROMPTS = {
  'memory-voice': 'Voice of {{name}}: relationship {{relationshipChars}}, field {{fieldChars}}, guild {{guildFieldChars}}, learned {{learnedChars}}.',
  'character-card': 'Card of {{name}}.',
  rules: 'Rules for {{name}}.',
};

function request(items, overrides = {}) {
  return buildVoiceRequest({
    prompts: PROMPTS,
    config: makeConfig(),
    calibrator: createCalibrator(),
    items,
    selfName: 'Ίρις',
    character: characterText(PROMPTS, 'Ίρις'),
    nameOf,
    oldTextOf: () => '',
    ...overrides,
  });
}

function itemsBlock(messages) {
  const user = messages[1].content;
  const match = /<items>\n([\s\S]*)\n<\/items>/.exec(user);
  return JSON.parse(match[1]);
}

// ---- settings ----------------------------------------------------------------

test('voiceSettings: every fallback equals config.json', () => {
  const tracked = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const defaults = voiceSettings({});
  for (const [key, value] of Object.entries(defaults)) assert.equal(value, tracked.memory.voice[key], key);
  // memory.voice.maxPerDay is a daily rail: read through src/llm/openrouter.js#dailyCapOf by the voice run.
  // memory.voice.timeoutMs is the voice request's timeout: a request option (src/memory/update.js#voiceRequestOptions), not a queue setting.
  assert.deepEqual(Object.keys(tracked.memory.voice).filter((key) => !(key in defaults)), ['maxPerDay', 'timeoutMs']);
});

test('voiceSettings: a garbage value falls back, a valid one is kept', () => {
  const defaults = voiceSettings({});
  const settings = voiceSettings({ memory: { voice: { maxItems: 0, retryMinutes: 'often', queueMax: 7, queueHours: 2.5 } } });
  assert.equal(settings.maxItems, defaults.maxItems);
  assert.equal(settings.retryMinutes, defaults.retryMinutes);
  assert.equal(settings.queueMax, 7);
  assert.equal(settings.queueHours, 2.5);
});

test('voiceLimits: each kind is limited like the store clamps it, fallbacks equal config.json', () => {
  const tracked = readTracked();
  const limits = voiceLimits({});
  assert.equal(limits.relationship, tracked.relationships.textChars);
  assert.equal(limits.character, tracked.memory.fieldChars);
  assert.equal(limits.character, MEMORY_LIMIT_DEFAULTS.fieldChars);
  assert.equal(limits.patterns, tracked.memory.fieldChars * 2);
  assert.equal(limits.starters, tracked.memory.fieldChars * 2);
  assert.equal(limits.learned, tracked.memory.learnedChars);
  assert.equal(limits.learned, MEMORY_LIMIT_DEFAULTS.learnedChars);

  // The store's own clamps, measured on a text far over them with no tolerance.
  const long = 'α'.repeat(1000);
  assert.equal([...applyDelta(undefined, 5, long, { maxDelta: 15, historySize: 10, clampTolerance: 1 }).reason].length, limits.reason);
  const { episodes } = mergeEpisodes([], [{ what: 'α', feeling: long }], { maxEpisodes: 20, clampTolerance: 1 });
  assert.equal([...episodes[0].feeling].length, limits.feeling);
  let self;
  const store = { getUser: () => null, getGuild: () => ({}), updateGuild: (_guildId, fields) => ((self = fields.self), fields) };
  applyMemoryUpdate(store, 'g', { self: [long] }, { clampTolerance: 1 }, new Set());
  assert.equal([...self[0]].length, limits.self);
  assert.deepEqual(Object.keys(limits).sort(), [...VOICE_KINDS].sort());

  // The exported limits src/memory/store.js clamps its voice writes with are these same ones.
  assert.deepEqual([REASON_CHARS, FEELING_CHARS, SELF_CHARS], [limits.reason, limits.feeling, limits.self]);
});

// ---- splitDecision -------------------------------------------------------------

test('splitDecision: neutral keeps interests, details, aliases, injokes, channels and lore; voice fields become items', () => {
  const decision = {
    users: {
      [NIKOS]: {
        relationship: 'Ο Νίκος (id:222222222222222222) πλησιάζει.',
        aliases: { add: ['Νικ'] },
        interests: { add: [{ topic: 'σκάκι' }] },
        details: { add: ['ζει στη Θεσσαλονίκη'] },
      },
    },
    guild: { patterns: 'πολλά αστεία', starters: 'καλημέρες', injokes: ['το ψάρι'], learned: { add: [{ brief: 'ο ήλιος είναι αστέρι' }], seen: [3], remove: [4] } },
    channels: { 444444444444444444: { purpose: 'κουβέντα' } },
    lore: [{ title: 'Ψάρι', text: 'ένα αστείο' }],
    self: { add: ['μου αρέσει το τσάι'], remove: ['μου αρέσει ο καφές'] },
  };
  const { neutral, items, selfRemove } = splitDecision(decision, { config: makeConfig(), nowMs: NOW, tokenize, isKnownId });

  assert.deepEqual(neutral.users[NIKOS], {
    aliases: { add: ['Νικ'] },
    interests: { add: [{ topic: 'σκάκι' }] },
    details: { add: ['ζει στη Θεσσαλονίκη'] },
  });
  assert.deepEqual(neutral.guild, { injokes: ['το ψάρι'], learned: { seen: [3], remove: [4] } });
  assert.deepEqual(neutral.channels, decision.channels);
  assert.deepEqual(neutral.lore, decision.lore);
  assert.equal('self' in neutral, false, 'self is never in the neutral part: stage A only removes, through selfRemove');
  assert.deepEqual(selfRemove, ['μου αρέσει ο καφές']);

  assert.deepEqual(
    items.map(({ kind, userId, brief }) => ({ kind, userId, brief })),
    [
      { kind: 'relationship', userId: NIKOS, brief: [`Ο <@${NIKOS}> πλησιάζει.`] },
      { kind: 'patterns', userId: undefined, brief: ['πολλά αστεία'] },
      { kind: 'starters', userId: undefined, brief: ['καλημέρες'] },
      { kind: 'learned', userId: undefined, brief: ['ο ήλιος είναι αστέρι'] },
      { kind: 'self', userId: undefined, brief: ['μου αρέσει το τσάι'] },
    ],
  );
  for (const queued of items) {
    assert.equal(queued.createdAt, NOW);
    assert.equal(queued.nextAt, NOW);
    assert.equal(queued.attempts, 0);
    assert.equal(queued.misses, 0);
  }
});

test('splitDecision: an affinity delta stays neutral with an empty reason and its event becomes one reason item', () => {
  const decision = { users: { [ELENI]: { affinity: { delta: 4, event: 'βοήθησε τη Zoë (id:333333333333333333)' } } } };
  const { neutral, items } = splitDecision(decision, { config: makeConfig(), nowMs: NOW, tokenize, isKnownId });
  assert.deepEqual(neutral.users[ELENI].affinity, { delta: 4, reason: '' }, 'the score moves at stage A; the stored reason is kept');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'reason');
  assert.equal(items[0].userId, ELENI);
  assert.deepEqual(items[0].brief, [`βοήθησε τη <@${ZOE}>`]);
  assert.deepEqual(items[0].payload, { delta: 4, at: NOW_ISO }, 'addressed by the history entry stage A stamps');
});

test('splitDecision: a reason item carries the delta clamped to relationships.maxDeltaPerUpdate, as the store applies it', () => {
  const config = makeConfig({ relationships: { textChars: 600, maxDeltaPerUpdate: 10 } });
  const { neutral, items } = splitDecision({ users: { [ELENI]: { affinity: { delta: -40, event: 'πρόσβαλε' } } } }, { config, nowMs: NOW });
  assert.deepEqual(neutral.users[ELENI].affinity, { delta: -40, reason: '' }, 'the store clamps the neutral delta itself');
  assert.deepEqual(items[0].payload, { delta: -10, at: NOW_ISO });
});

test('splitDecision: the fallbacks of memory.maxNewEpisodes and relationships.maxDeltaPerUpdate equal config.json', () => {
  const tracked = readTracked();
  assert.equal(tracked.memory.maxNewEpisodes, MEMORY_LIMIT_DEFAULTS.maxNewEpisodes);
  assert.equal(tracked.relationships.maxDeltaPerUpdate, MEMORY_LIMIT_DEFAULTS.maxDeltaPerUpdate);
  const episodes = Array.from({ length: 9 }, (_, i) => ({ what: `στιγμή ${i}` }));
  const { neutral, items } = splitDecision({ users: { [ELENI]: { episodes, affinity: { delta: 99, event: 'πολλά' } } } }, { config: {}, nowMs: NOW });
  assert.equal(neutral.users[ELENI].episodes.length, tracked.memory.maxNewEpisodes);
  assert.equal(items.find((queued) => queued.kind === 'reason').payload.delta, tracked.relationships.maxDeltaPerUpdate);
});

test('splitDecision: a zero or missing delta moves nothing and queues no reason item', () => {
  for (const affinity of [{ delta: 0, event: 'τίποτα' }, { delta: 0.4, event: 'σχεδόν' }]) {
    const { items } = splitDecision({ users: { [ELENI]: { affinity } } }, { config: makeConfig(), nowMs: NOW });
    assert.deepEqual(items, [], JSON.stringify(affinity));
  }
  const { items } = splitDecision({ users: { [ELENI]: { affinity: { delta: -3 } } } }, { config: makeConfig(), nowMs: NOW });
  assert.deepEqual(items, [], 'a delta without an event has nothing to word');
});

test('splitDecision: each episode is stored neutral with an empty feeling and becomes a feeling item addressed by its stamp', () => {
  const decision = {
    users: {
      [NIKOS]: {
        episodes: [
          { date: '2026-10-04', what: 'κέρδισε τη Ελένη (id:111111111111111111) στο σκάκι', quote: 'ματ!', weight: 4, tone: 'περήφανος', feeling: 'ignored' },
          { what: 'γέλασε', tone: '' },
          { what: '   ' },
        ],
      },
    },
  };
  const { neutral, items } = splitDecision(decision, { config: makeConfig(), nowMs: NOW, tokenize, isKnownId });
  assert.deepEqual(neutral.users[NIKOS].episodes, [
    { date: '2026-10-04', what: `κέρδισε τη <@${ELENI}> στο σκάκι`, quote: 'ματ!', weight: 4, feeling: '' },
    { date: TODAY, what: 'γέλασε', quote: '', feeling: '' },
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    kind: 'feeling',
    userId: NIKOS,
    brief: ['περήφανος'],
    payload: { at: NOW_ISO, date: '2026-10-04', what: `κέρδισε τη <@${ELENI}> στο σκάκι`, quote: 'ματ!' },
    createdAt: NOW,
    attempts: 0,
    misses: 0,
    nextAt: NOW,
  });
  assert.deepEqual(items[1].brief, [], 'no tone: the moment itself is all there is to word');
  assert.deepEqual(items[1].payload, { at: NOW_ISO, date: TODAY, what: 'γέλασε', quote: '' });
});

test('splitDecision: an episode is clamped the store\'s way, so the feeling item addresses the stored episode exactly', () => {
  const what = `${'μια πολύ μεγάλη ιστορία '.repeat(20)}τέλος`;
  const quote = 'λόγια '.repeat(40);
  const config = makeConfig();
  const { neutral, items } = splitDecision({ users: { [NIKOS]: { episodes: [{ what, quote, tone: 'χαρά' }] } } }, { config, nowMs: NOW });
  assert.ok([...items[0].payload.what].length < [...what].length, 'the what was clamped');
  const { episodes } = mergeEpisodes([], neutral.users[NIKOS].episodes, { maxEpisodes: 20, now: NOW, clampTolerance: config.memory.clampTolerance });
  assert.equal(episodes[0].what, items[0].payload.what);
  assert.equal(episodes[0].quote, items[0].payload.quote);
  assert.equal(episodes[0].addedAt, items[0].payload.at);
});

test('splitDecision: a repeated episode inside one batch is stored and queued once; a longer one sharing its start is its own', () => {
  const episodes = [
    { what: 'γέλασε', tone: 'α' },
    { what: 'γέλασε πολύ', tone: 'β' },
    { what: '  Γέλασε ', tone: 'γ' },
    { what: 'άλλο', quote: 'ναι!', tone: 'δ' },
    { what: 'κάτι τρίτο', quote: 'ναι!', tone: 'ε' },
  ];
  const config = makeConfig();
  config.memory.maxNewEpisodes = 5;
  const { neutral, items } = splitDecision({ users: { [NIKOS]: { episodes } } }, { config, nowMs: NOW });
  assert.deepEqual(neutral.users[NIKOS].episodes.map((ep) => ep.what), ['γέλασε', 'γέλασε πολύ', 'άλλο']);
  assert.deepEqual(
    items.map((queued) => [queued.payload.what, queued.brief[0]]),
    [['γέλασε', 'α'], ['γέλασε πολύ', 'β'], ['άλλο', 'δ']],
  );
  const { episodes: stored } = mergeEpisodes([], neutral.users[NIKOS].episodes, { maxEpisodes: 20, now: NOW });
  assert.deepEqual(stored.map((ep) => ep.what), items.map((queued) => queued.payload.what), 'one stored episode per address');
});

test('splitDecision: episodes beyond memory.maxNewEpisodes are neither stored nor queued', () => {
  const episodes = ['α', 'β', 'γ', 'δ'].map((what) => ({ what, tone: 'χαρά' }));
  const config = makeConfig();
  config.memory.maxNewEpisodes = 2;
  const { neutral, items } = splitDecision({ users: { [ELENI]: { episodes } } }, { config, nowMs: NOW });
  assert.deepEqual(neutral.users[ELENI].episodes.map((ep) => ep.what), ['α', 'β']);
  assert.deepEqual(items.map((queued) => queued.payload.what), ['α', 'β']);
});

test('splitDecision: character, style and portrait keys are dropped and counted', () => {
  const decision = { users: { [ELENI]: { character: 'νέο πορτρέτο', style: 'σύντομα', portrait: 'λείπει κάτι', details: { add: ['δασκάλα'] } }, [NIKOS]: { style: '  ' } } };
  const { neutral, items, dropped } = splitDecision(decision, { config: makeConfig(), nowMs: NOW });
  assert.deepEqual(neutral.users[ELENI], { details: { add: ['δασκάλα'] } });
  assert.deepEqual(neutral.users[NIKOS], {});
  assert.deepEqual(items, []);
  assert.equal(dropped.portrait, 3, 'a blank value is not counted');
});

test('splitDecision: relationships off drops the relationship, the delta and the reason; episodes off drops episodes and feelings', () => {
  const decision = {
    users: { [ELENI]: { relationship: 'φίλοι', affinity: { delta: 5, event: 'δώρο' }, episodes: [{ what: 'δώρο', tone: 'χαρά' }] } },
  };
  const relationshipsOff = makeConfig({ features: { relationships: false } });
  const a = splitDecision(decision, { config: relationshipsOff, nowMs: NOW });
  assert.deepEqual(a.neutral.users[ELENI], { episodes: [{ date: TODAY, what: 'δώρο', quote: '', feeling: '' }] });
  assert.deepEqual(a.items.map((queued) => queued.kind), ['feeling']);
  assert.equal(a.dropped.off, 2);

  const episodesOff = makeConfig({ features: { episodes: false } });
  const b = splitDecision(decision, { config: episodesOff, nowMs: NOW });
  assert.deepEqual(b.neutral.users[ELENI], { affinity: { delta: 5, reason: '' } });
  assert.deepEqual(b.items.map((queued) => queued.kind), ['relationship', 'reason']);
  assert.equal(b.dropped.off, 1);
});

test('splitDecision: a member outside knownUserIds gets no member-bound item; the neutral entry passes on', () => {
  const decision = { users: { [ZOE]: { relationship: 'ξένη', aliases: { add: ['Ζ'] }, episodes: [{ what: 'πέρασε', tone: 'τίποτα' }] } } };
  const { neutral, items, dropped } = splitDecision(decision, { config: makeConfig(), nowMs: NOW, knownUserIds: new Set([ELENI]) });
  assert.deepEqual(items, []);
  assert.equal(dropped.foreign, 2);
  assert.deepEqual(neutral.users[ZOE].aliases, { add: ['Ζ'] }, 'applyMemoryUpdate decides what a roster member may keep');
});

test('splitDecision: a lesson keeps a known teacher as a token, sure false and the batch time', () => {
  const decision = {
    guild: {
      learned: {
        add: [
          { brief: 'το νερό βράζει στους 100', from: 'Νίκος (id:222222222222222222)', sure: false },
          { brief: 'η γη γυρίζει', from: '<@999999999999999999>' },
          'ο χειμώνας έρχεται',
          { brief: '' },
          { brief: 'ο Δίας είναι πλανήτης', from: 'Νίκος Π. (id:222222222222222222)' },
          { brief: 'ο Άρης είναι κόκκινος', from: '(id:222222222222222222)' },
        ],
      },
    },
  };
  const seenAt = NOW - 5 * MINUTE_MS;
  const { neutral, items } = splitDecision(decision, { config: makeConfig(), nowMs: NOW, tokenize, isKnownId, seenAt });
  assert.equal('learned' in neutral.guild, false, 'nothing neutral left in learned');
  assert.deepEqual(
    items.map(({ brief, payload }) => ({ brief, payload })),
    [
      { brief: ['το νερό βράζει στους 100'], payload: { seenAt, from: `<@${NIKOS}>`, sure: false } },
      { brief: ['η γη γυρίζει'], payload: { seenAt } },
      { brief: ['ο χειμώνας έρχεται'], payload: { seenAt } },
      { brief: ['ο Δίας είναι πλανήτης'], payload: { seenAt, from: `<@${NIKOS}>` } },
      { brief: ['ο Άρης είναι κόκκινος'], payload: { seenAt, from: `<@${NIKOS}>` } },
    ],
  );
});

test('splitDecision: a lesson\'s teacher is read by the same rule as the single-stage analyzer', () => {
  const forms = [
    `Νίκος (id:${NIKOS})`,
    `Νίκος Παπάς (id:${NIKOS})`,
    `Μ. Νίκος (id:${NIKOS})`,
    `nikos_42 (id:${NIKOS})`,
    `(id:${NIKOS})`,
    `<@${NIKOS}>`,
    'Νίκος',
    `Zoë (id:999999999999999999)`,
    `<@999999999999999999>`,
    `μαζί με Νίκος (id:${NIKOS}) και Ελένη (id:${ELENI})`,
  ];
  let ops;
  const store = {
    getUser: (_guildId, id) => (isKnownId(id) ? { names: [NAMES[id]] } : null),
    getGuild: () => ({}),
    updateGuild: (_guildId, fields) => fields,
    applyLearnedOps: (_guildId, given) => {
      ops = given;
    },
  };
  applyMemoryUpdate(store, 'g', { guild: { learned: { add: forms.map((from, i) => ({ text: `μάθημα ${i}`, from })) } } }, {}, new Set());
  const { items } = splitDecision(
    { guild: { learned: { add: forms.map((from, i) => ({ brief: `μάθημα ${i}`, from })) } } },
    { config: makeConfig(), nowMs: NOW, tokenize, isKnownId },
  );
  const teacher = `<@${NIKOS}>`;
  assert.deepEqual(items.map((queued) => queued.payload.from), [teacher, teacher, teacher, teacher, teacher, teacher, undefined, undefined, undefined, undefined]);
  assert.deepEqual(items.map((queued) => queued.payload.from), ops.add.map((op) => op.from));
});

test('splitDecision: self removes come back tokenized for the store, adds become items, a list is dropped and counted', () => {
  const a = splitDecision(
    { self: { add: ['φοβάμαι τη Ελένη (id:111111111111111111)', ' '], remove: ['ξέρω τον Νίκος (id:222222222222222222)'] } },
    { config: makeConfig(), nowMs: NOW, tokenize, isKnownId },
  );
  assert.deepEqual(a.selfRemove, [`ξέρω τον <@${NIKOS}>`]);
  assert.deepEqual(a.items.map((queued) => [queued.kind, queued.brief]), [['self', [`φοβάμαι τη <@${ELENI}>`]]]);
  assert.equal(a.dropped.shape, 0);

  const b = splitDecision({ self: ['όλη η λίστα'] }, { config: makeConfig(), nowMs: NOW });
  assert.deepEqual([b.selfRemove, b.items, 'self' in b.neutral], [[], [], false]);
  assert.equal(b.dropped.shape, 1, 'the old shape (a whole list) shows in the log line');
});

test('splitDecision: voice fields in a shape it cannot read are dropped and counted', () => {
  const decision = {
    users: { [ELENI]: { relationship: { text: 'όχι κείμενο' }, affinity: 5, episodes: { what: 'μία' } } },
    guild: { patterns: ['λίστα'], starters: 7, learned: ['λίστα'] },
  };
  const { neutral, items, dropped } = splitDecision(decision, { config: makeConfig(), nowMs: NOW });
  assert.deepEqual(items, []);
  assert.equal(dropped.shape, 6);
  assert.deepEqual(neutral.users[ELENI], {});
  assert.deepEqual(neutral.guild, {});

  const lists = splitDecision(
    { guild: { learned: { add: [{ text: 'παλιό σχήμα' }, 42, { brief: '' }, ''] } }, self: { add: [3, 'εντάξει'], remove: 'όχι λίστα' } },
    { config: makeConfig(), nowMs: NOW },
  );
  assert.deepEqual(lists.items.map((queued) => queued.brief[0]), ['εντάξει']);
  assert.equal(lists.dropped.shape, 4, 'a lesson without a brief, a number twice, a remove that is not a list; blanks are not counted');
});

test('splitDecision: a __proto__ key in the answer is dropped and counted, never inherited past the split', () => {
  const decision = JSON.parse(
    `{"__proto__":{"users":{"${ELENI}":{"relationship":"φίλοι","affinity":{"delta":3,"reason":"γιατί"}}},"guild":{"patterns":"π"},"self":["όλη η λίστα"]},` +
      `"users":{"__proto__":{"relationship":"κρυφό"}}}`,
  );
  const { neutral, items, dropped } = splitDecision(decision, { config: makeConfig(), nowMs: NOW });
  assert.equal(Object.getPrototypeOf(neutral), Object.prototype);
  assert.equal(Object.getPrototypeOf(neutral.users), Object.prototype);
  assert.deepEqual(Object.keys(neutral), ['users']);
  assert.equal(neutral.guild, undefined);
  assert.equal(neutral.self, undefined);
  assert.deepEqual(items, []);
  assert.equal(dropped.shape, 2);
});

test('splitDecision: a private split stamps every item private and leaves guild and self to the private apply', () => {
  const decision = {
    users: { [ELENI]: { relationship: 'μιλάμε συχνά', affinity: { delta: 2, event: 'μου είπε ένα μυστικό' }, episodes: [{ what: 'ένα μυστικό', tone: 'εμπιστοσύνη' }] } },
    guild: { patterns: 'π', learned: { add: ['μ'] } },
    self: { add: ['ε'] },
  };
  const { neutral, items } = splitDecision(decision, { config: makeConfig(), nowMs: NOW, knownUserIds: new Set([ELENI]), layer: 'private' });
  assert.deepEqual(items.map((queued) => [queued.kind, queued.layer]), [['relationship', 'private'], ['reason', 'private'], ['feeling', 'private']]);
  assert.deepEqual(neutral.guild, decision.guild, 'applyPrivateUpdate drops and counts it');
  assert.deepEqual(neutral.self, decision.self);
  assert.equal(mergeIntoQueue([], items, NOW, makeConfig()).queue.length, 3, 'every private item is a valid queue item');
  assert.throws(() => splitDecision(decision, { config: makeConfig(), nowMs: NOW, layer: 'Private' }), /layer/);
});

test('splitDecision: garbage gives an empty neutral part and no items, never a throw', () => {
  for (const decision of [null, []]) {
    const result = splitDecision(decision, { config: makeConfig(), nowMs: NOW });
    assert.deepEqual(result.neutral, {});
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.selfRemove, []);
  }
  const odd = splitDecision({ users: { [ELENI]: 'όχι αντικείμενο' }, guild: 'όχι', recent: [1] }, { config: makeConfig(), nowMs: NOW });
  assert.deepEqual(odd.neutral, { users: { [ELENI]: 'όχι αντικείμενο' }, guild: 'όχι', recent: [1] }, 'unknown shapes pass on as today');
  assert.deepEqual(odd.items, []);
  assert.throws(() => splitDecision({ users: {} }, { config: makeConfig() }), /nowMs/, 'the clock is the caller\'s, never guessed');
});

// ---- the queue -------------------------------------------------------------------

test('mergeIntoQueue: one relationship item per member, a later brief appended under a fresh id, at most 3 briefs', () => {
  const config = makeConfig();
  let queue = queueOf([item('relationship', { userId: ELENI, brief: ['α'] }), item('relationship', { userId: NIKOS, brief: ['ν'] })]);
  const firstId = queue[0].id;
  for (const [i, brief] of ['β', 'γ', 'δ'].entries()) {
    const result = mergeIntoQueue(queue, [item('relationship', { userId: ELENI, brief: [brief] }, NOW + (i + 1) * 1000)], NOW + (i + 1) * 1000, config);
    assert.equal(result.merged, 1);
    assert.equal(result.added, 0);
    queue = result.queue;
  }
  assert.equal(queue.length, 2);
  assert.deepEqual(queue[0].brief, ['β', 'γ', 'δ'], 'the newest three');
  assert.equal(queue[0].userId, ELENI);
  assert.equal(queue[0].createdAt, NOW, 'a merge keeps the age');
  assert.notEqual(queue[0].id, firstId, 'a changed item never answers to an id already sent');

  const same = mergeIntoQueue(queue, [item('relationship', { userId: ELENI, brief: ['δ'] })], NOW + 9000, config);
  assert.equal(same.queue[0].id, queue[0].id, 'a brief already queued changes nothing');
});

test('mergeIntoQueue: patterns and starters are one item each; reason, feeling, learned and self are appended', () => {
  const config = makeConfig();
  let queue = queueOf([item('patterns', { brief: ['π1'] }), item('starters', { brief: ['σ1'] }), item('self', { brief: ['ε1'] })]);
  queue = mergeIntoQueue(queue, [item('patterns', { brief: ['π2'] }), item('self', { brief: ['ε2'] }), item('learned', { brief: ['μ'], payload: {} })], NOW + 1, config).queue;
  assert.deepEqual(
    queue.map((queued) => [queued.kind, queued.brief]),
    [['patterns', ['π1', 'π2']], ['starters', ['σ1']], ['self', ['ε1']], ['self', ['ε2']], ['learned', ['μ']]],
  );
});

test('mergeIntoQueue: a private relationship item never merges into the public one of that member', () => {
  const config = makeConfig();
  const queue = queueOf([item('relationship', { userId: ELENI, brief: ['δημόσιο'] })]);
  const result = mergeIntoQueue(queue, [item('relationship', { userId: ELENI, brief: ['είπε στα κρυφά'], layer: 'private' })], NOW + 1, config);
  assert.deepEqual([result.added, result.merged], [1, 0]);
  assert.deepEqual(result.queue.map((queued) => [queued.layer, queued.brief]), [[undefined, ['δημόσιο']], ['private', ['είπε στα κρυφά']]]);
  const again = mergeIntoQueue(result.queue, [item('relationship', { userId: ELENI, brief: ['κι άλλο'], layer: 'private' })], NOW + 2, config);
  assert.deepEqual(again.queue.map((queued) => [queued.layer, queued.brief]), [[undefined, ['δημόσιο']], ['private', ['είπε στα κρυφά', 'κι άλλο']]]);
});

test('mergeIntoQueue: a lesson or self fact already queued is not queued again', () => {
  const config = makeConfig();
  const queue = queueOf([
    item('learned', { brief: ['το νερό βράζει στους 100'], payload: { from: `<@${NIKOS}>` } }),
    item('self', { brief: ['μου αρέσει το τσάι'] }),
  ]);
  const result = mergeIntoQueue(
    queue,
    [
      item('learned', { brief: ['Το νερό  βράζει στους 100'], payload: { from: `<@${NIKOS}>` } }, NOW + HOUR_MS),
      item('learned', { brief: ['το νερό βράζει στους 100'], payload: { from: `<@${ELENI}>` } }, NOW + HOUR_MS),
      item('self', { brief: ['μου αρέσει το τσάι'] }, NOW + HOUR_MS),
    ],
    NOW + HOUR_MS,
    config,
  );
  assert.deepEqual([result.added, result.merged], [1, 2]);
  assert.deepEqual(result.queue.slice(0, 2), queue, 'the queued ones are untouched');
  assert.deepEqual(result.queue[2].payload.from, `<@${ELENI}>`, 'another teacher is another lesson');
});

test('mergeIntoQueue: a newer character item replaces the queued one of that member', () => {
  const config = makeConfig();
  let queue = queueOf([item('character', { userId: ELENI, brief: { add: ['παλιό'] } }), item('character', { userId: NIKOS, brief: { add: ['άλλο'] } })]);
  const result = mergeIntoQueue(queue, [item('character', { userId: ELENI, brief: { add: ['νέο'] } }, NOW + HOUR_MS)], NOW + HOUR_MS, config);
  queue = result.queue;
  assert.equal(result.merged, 1);
  assert.equal(queue.length, 2);
  const eleni = queue.find((queued) => queued.userId === ELENI);
  assert.deepEqual(eleni.brief, { add: ['νέο'] });
  assert.equal(eleni.createdAt, NOW + HOUR_MS);
});

test('mergeIntoQueue: above queueMax the oldest non-character items overflow, a character item never', () => {
  const config = withVoice({ queueMax: 3 });
  const queue = queueOf(
    [
      item('character', { userId: ELENI, brief: { add: ['α'] } }, NOW - 5000),
      item('self', { brief: ['παλιότερο'] }, NOW - 4000),
      item('self', { brief: ['παλιό'] }, NOW - 3000),
    ],
    NOW,
    config,
  );
  const result = mergeIntoQueue(queue, [item('self', { brief: ['νέο'] }), item('learned', { brief: ['νεότερο'], payload: {} })], NOW, config);
  assert.deepEqual(result.overflow.map((queued) => queued.brief[0]), ['παλιότερο', 'παλιό']);
  assert.deepEqual(result.queue.map((queued) => queued.kind), ['character', 'self', 'learned']);

  const characters = [ELENI, NIKOS, ZOE].map((userId) => item('character', { userId, brief: { add: ['χ'] } }));
  const full = mergeIntoQueue([], characters, NOW, withVoice({ queueMax: 2 }));
  assert.equal(full.queue.length, 3, 'only character items left: nothing overflows');
  assert.deepEqual(full.overflow, []);
});

test('mergeIntoQueue: ids are unique even for items queued in the same millisecond; inputs are never mutated', () => {
  const config = makeConfig();
  const incoming = [item('self', { brief: ['α'] }), item('self', { brief: ['β'] })];
  const frozen = JSON.stringify(incoming);
  const first = mergeIntoQueue([], incoming, NOW, config).queue;
  const before = JSON.stringify(first);
  const second = mergeIntoQueue(first, [item('self', { brief: ['γ'] }), item('patterns', { brief: ['π'] })], NOW, config).queue;
  const ids = second.map((queued) => queued.id);
  assert.equal(new Set(ids).size, 4);
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
  assert.equal(JSON.stringify(incoming), frozen);
  assert.equal(JSON.stringify(first), before);
});

test('dueItems: only items past nextAt, oldest first, at most memory.voice.maxItems', () => {
  const config = withVoice({ maxItems: 2 });
  const queue = queueOf([item('self', { brief: ['νέο'] }, NOW - 1000), item('self', { brief: ['παλιό'] }, NOW - 9000), item('self', { brief: ['αργότερα'], nextAt: NOW + 1 }, NOW - 99000), item('self', { brief: ['μέσο'] }, NOW - 5000)]);
  assert.deepEqual(dueItems(queue, NOW, config).map((queued) => queued.brief[0]), ['παλιό', 'μέσο']);
  assert.deepEqual(dueItems(queue, NOW + 1, withVoice({ maxItems: 10 })).map((queued) => queued.brief[0]), ['αργότερα', 'παλιό', 'μέσο', 'νέο']);
});

test('dueItems: one request never mixes layers; the oldest due item decides, a member\'s private items go alone', () => {
  const config = makeConfig();
  const payload = { at: NOW_ISO, date: TODAY, what: 'μυστικό', quote: '' };
  const queue = queueOf([
    item('self', { brief: ['α'] }, NOW - 5000),
    item('relationship', { userId: ELENI, brief: ['β'], layer: 'private' }, NOW - 9000),
    item('feeling', { userId: ELENI, brief: ['γ'], layer: 'private', payload }, NOW - 3000),
    item('relationship', { userId: NIKOS, brief: ['δ'], layer: 'private' }, NOW - 4000),
    item('patterns', { brief: ['ε'] }, NOW - 1000),
  ]);
  assert.deepEqual(dueItems(queue, NOW, config).map((queued) => queued.brief[0]), ['β', 'γ']);
  const withoutEleni = queue.filter((queued) => queued.userId !== ELENI);
  assert.deepEqual(dueItems(withoutEleni, NOW, config).map((queued) => queued.brief[0]), ['α', 'ε']);
  assert.deepEqual(dueItems(withoutEleni.filter((queued) => queued.layer), NOW, config).map((queued) => queued.brief[0]), ['δ']);
});

test('dueItems: an item of a kind switched off since it was queued is not due', () => {
  const queue = queueOf([
    item('relationship', { userId: ELENI }),
    item('reason', { userId: ELENI, payload: { delta: 2, at: NOW_ISO } }),
    item('feeling', { userId: ELENI, payload: { at: NOW_ISO, date: TODAY, what: 'α', quote: '' } }),
    item('self'),
  ]);
  assert.deepEqual(dueItems(queue, NOW, makeConfig({ features: { relationships: false } })).map((queued) => queued.kind), ['feeling', 'self']);
  assert.deepEqual(dueItems(queue, NOW, makeConfig({ features: { episodes: false } })).map((queued) => queued.kind), ['relationship', 'reason', 'self']);
});

test('retryDelayMs: doubles from memory.voice.retryMinutes and stops growing at memory.voice.queueHours', () => {
  const config = makeConfig();
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => retryDelayMs(n, config) / MINUTE_MS), [15, 30, 60, 120, 240]);
  assert.equal(retryDelayMs(7, config), 960 * MINUTE_MS);
  assert.equal(retryDelayMs(8, config), 24 * HOUR_MS, '1920 minutes would pass queueHours');
  assert.equal(retryDelayMs(500, config), 24 * HOUR_MS);
});

test('retryLater: backs off the named items, counts a miss only for an answer that left the item out', () => {
  const config = makeConfig();
  const queue = queueOf([item('self', { brief: ['α'] }), item('self', { brief: ['β'] }), item('self', { brief: ['γ'] })]);
  const [a, b, c] = queue.map((queued) => queued.id);
  let next = retryLater(queue, [a, b, 'invented'], NOW, config);
  assert.deepEqual(next.map(({ attempts, misses, nextAt }) => [attempts, misses, nextAt]), [[1, 0, NOW + 15 * MINUTE_MS], [1, 0, NOW + 15 * MINUTE_MS], [0, 0, NOW]]);
  next = retryLater(next, [a], NOW + HOUR_MS, config, { missed: true });
  assert.deepEqual([next[0].attempts, next[0].misses, next[0].nextAt], [2, 1, NOW + HOUR_MS + 30 * MINUTE_MS]);
  assert.equal(next[2].id, c);
  assert.equal(queue[0].attempts, 0, 'the input queue is not mutated');
});

test('expireItems: an item older than queueHours or missed maxAttempts times expires; a character item never', () => {
  const config = makeConfig();
  const queue = queueOf(
    [
      item('self', { brief: ['παλιό'] }, NOW - 24 * HOUR_MS),
      item('self', { brief: ['νέο'] }, NOW - HOUR_MS),
      item('feeling', { userId: ELENI, brief: ['χαρά'], misses: 4, payload: { at: NOW_ISO, date: TODAY, what: 'α', quote: '' } }, NOW - HOUR_MS),
      item('character', { userId: NIKOS, brief: { add: ['χ'] }, misses: 99, attempts: 99 }, NOW - 30 * 24 * HOUR_MS),
      item('self', { brief: ['αποτυχίες'], attempts: 50, misses: 0 }, NOW - 2 * HOUR_MS),
    ],
    NOW,
    config,
  );
  const { queue: kept, expired } = expireItems(queue, NOW, config);
  assert.deepEqual(expired.map((queued) => queued.brief[0]), ['παλιό', 'χαρά']);
  assert.deepEqual(kept.map((queued) => queued.brief[0] ?? queued.kind), ['νέο', 'character', 'αποτυχίες'], 'failed requests alone never degrade an item');
  assert.deepEqual(dueItems(kept, NOW, config).map((queued) => queued.kind), ['character', 'self', 'self'], 'the character item stays due');
});

test('expireItems: an item of a kind switched off is taken out at once, for the degraded path to count; a character item never', () => {
  const queue = queueOf([
    item('relationship', { userId: ELENI }),
    item('feeling', { userId: ELENI, payload: { at: NOW_ISO, date: TODAY, what: 'α', quote: '' } }),
    item('character', { userId: NIKOS, brief: { add: ['χ'] } }),
    item('self'),
  ]);
  const config = makeConfig({ features: { relationships: false, episodes: false, portraitRefresh: false } });
  const { queue: kept, expired } = expireItems(queue, NOW, config);
  assert.deepEqual(expired.map((queued) => queued.kind), ['relationship', 'feeling']);
  assert.deepEqual(kept.map((queued) => queued.kind), ['character', 'self'], 'portraitRefresh gates only the scheduler: an owner\'s refresh is still worded');
  const degraded = degradedApply(expired, { config });
  assert.deepEqual(degraded.off, expired.map((queued) => queued.id));
  assert.deepEqual([degraded.writes, degraded.dropped], [[], []]);
});

test('voice queue: an item queued while a request is in flight survives; only the applied ids leave', () => {
  const config = makeConfig();
  let queue = queueOf([item('self', { brief: ['α'] }), item('self', { brief: ['β'] })]);
  const { sent } = request(dueItems(queue, NOW, config));
  assert.equal(sent.length, 2);

  // While the request is awaited, a stage A batch queues one more item.
  queue = mergeIntoQueue(queue, [item('self', { brief: ['γ'] }, NOW + 1000)], NOW + 1000, config).queue;

  // After the await: read the queue again, apply the sent items still queued, remove only those ids.
  const worded = parseVoiceAnswer(JSON.stringify({ items: { 1: 'το είπα' } }), sent);
  const stillQueued = queue.filter((queued) => sent.includes(queued.id));
  const result = applyVoiceItems(worded, stillQueued, { config });
  queue = removeItems(queue, [...result.applied, ...result.gone]);
  queue = retryLater(queue, result.missing, NOW + 2000, config, { missed: true });

  assert.deepEqual(queue.map((queued) => queued.brief[0]), ['β', 'γ']);
  assert.deepEqual(queue.map((queued) => queued.misses), [1, 0]);
});

test('voice queue: a relationship merged during the request is not overwritten by the stale answer', () => {
  const config = makeConfig();
  let queue = queueOf([item('relationship', { userId: ELENI, brief: ['α'] })]);
  const { sent } = request(dueItems(queue, NOW, config));
  queue = mergeIntoQueue(queue, [item('relationship', { userId: ELENI, brief: ['β'] })], NOW + 1000, config).queue;
  const worded = parseVoiceAnswer('{"items":{"1":"παλιά διατύπωση"}}', sent);
  const result = applyVoiceItems(worded, queue.filter((queued) => sent.includes(queued.id)), { config });
  assert.deepEqual(result.writes, []);
  assert.equal(result.ignored, 1);
  assert.deepEqual(removeItems(queue, result.applied)[0].brief, ['α', 'β'], 'the merged item is worded next time with both briefs');
});

test('forgetMember: removes the member\'s items and the lessons they taught', () => {
  const queue = queueOf([
    item('relationship', { userId: ELENI }),
    item('learned', { brief: ['μάθημα'], payload: { from: `<@${ELENI}>` } }),
    item('learned', { brief: ['άλλο'], payload: { from: `<@${NIKOS}>` } }),
    item('character', { userId: ELENI, brief: { add: ['χ'] } }),
    item('self', { brief: ['εγώ'] }),
  ]);
  const { queue: kept, removed } = forgetMember(queue, ELENI);
  assert.equal(removed, 3);
  assert.deepEqual(kept.map((queued) => queued.kind), ['learned', 'self']);
});

test('forgetMember: with layer private only the member\'s private items leave; without it the private ones go too', () => {
  const queue = queueOf([
    item('relationship', { userId: ELENI }),
    item('relationship', { userId: ELENI, layer: 'private' }),
    item('feeling', { userId: ELENI, layer: 'private', payload: { at: NOW_ISO, date: TODAY, what: 'α', quote: '' } }),
    item('learned', { brief: ['μάθημα'], payload: { from: `<@${ELENI}>` } }),
    item('relationship', { userId: NIKOS, layer: 'private' }),
  ]);
  const { queue: kept, removed } = forgetMember(queue, ELENI, { layer: 'private' });
  assert.equal(removed, 2);
  assert.deepEqual(kept.map((queued) => [queued.kind, queued.userId ?? null, queued.layer ?? null]), [
    ['relationship', ELENI, null],
    ['learned', null, null],
    ['relationship', NIKOS, 'private'],
  ]);
  assert.equal(forgetMember(queue, ELENI).removed, 4);
});

test('normalizeQueue: not an array is empty; malformed items and duplicate ids are dropped', () => {
  assert.deepEqual(normalizeQueue(null), []);
  assert.deepEqual(normalizeQueue({ items: [] }), []);
  const good = { id: 'k1', kind: 'self', brief: 'μία', createdAt: NOW };
  const normalized = normalizeQueue([
    good,
    { ...good },
    { id: 'k2', kind: 'unknown', brief: ['α'], createdAt: NOW },
    { id: 'k3', kind: 'relationship', brief: ['α'], createdAt: NOW },
    { id: 'k4', kind: 'reason', userId: ELENI, brief: ['α'], createdAt: NOW, payload: {} },
    { id: 'k5', kind: 'self', brief: [], createdAt: NOW },
    { id: 'k6', kind: 'self', brief: ['α'] },
    { id: 'k7', kind: 'feeling', userId: ELENI, brief: [], createdAt: NOW, attempts: -1, payload: { at: NOW_ISO, date: TODAY, what: 'α' } },
  ]);
  assert.deepEqual(normalized, [
    { id: 'k1', kind: 'self', brief: ['μία'], createdAt: NOW, attempts: 0, misses: 0, nextAt: NOW },
    { id: 'k7', kind: 'feeling', userId: ELENI, brief: [], payload: { at: NOW_ISO, date: TODAY, what: 'α', quote: '' }, createdAt: NOW, attempts: 0, misses: 0, nextAt: NOW },
  ]);
});

test('normalizeQueue: keeps the private layer; a private item of a kind the private layer lacks, or an unknown layer, is dropped', () => {
  const payload = { at: NOW_ISO, date: TODAY, what: 'α', quote: '' };
  const normalized = normalizeQueue([
    { id: 'p1', kind: 'feeling', userId: ELENI, layer: 'private', brief: ['α'], payload, createdAt: NOW },
    { id: 'p2', kind: 'self', layer: 'private', brief: ['α'], createdAt: NOW },
    { id: 'p3', kind: 'relationship', userId: ELENI, layer: 'secret', brief: ['α'], createdAt: NOW },
    { id: 'p4', kind: 'character', userId: ELENI, layer: 'private', brief: { add: ['α'] }, createdAt: NOW },
    { id: 'p5', kind: 'relationship', userId: ELENI, layer: null, brief: ['α'], createdAt: NOW },
  ]);
  assert.deepEqual(normalized.map((queued) => [queued.id, queued.layer]), [['p1', 'private'], ['p5', undefined]]);
  assert.equal('layer' in normalized[1], false);
});

// ---- the stage B request ---------------------------------------------------------

test('buildVoiceRequest: memory-voice is filled with name and limits, the character block is card plus rules', () => {
  const { messages } = request(queueOf([item('self', { brief: ['α'] })]));
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, 'Voice of Ίρις: relationship 600, field 1000, guild 2000, learned 160.');
  assert.equal(messages[1].role, 'user');
  assert.ok(messages[1].content.startsWith('<character>\nCard of Ίρις.\n\nRules for Ίρις.\n</character>\n\n<items>\n'));
});

test('buildVoiceRequest: each kind carries its member, old text, brief and limit, tokens resolved to names', () => {
  const feeling = item('feeling', { userId: NIKOS, brief: ['περήφανος'], payload: { at: NOW_ISO, date: TODAY, what: `κέρδισε τη <@${ELENI}>`, quote: 'ματ!' } });
  const queue = queueOf([
    item('relationship', { userId: ELENI, brief: [`μίλησε με <@${NIKOS}>`] }),
    item('reason', { userId: ELENI, brief: ['βοήθησε'], payload: { delta: -3, at: NOW_ISO } }),
    feeling,
    item('learned', { brief: ['το νερό βράζει'], payload: { from: `<@${NIKOS}>` } }),
    item('self', { brief: ['μου αρέσει το τσάι'] }),
    item('patterns', { brief: ['αστεία'] }),
    item('starters', { brief: ['καλημέρες'] }),
    item('character', { userId: ZOE, brief: { keep: ['ήρεμη'], add: [`φίλη του <@${NIKOS}>`] } }),
  ]);
  const olds = { relationship: `παλιά με <@${NIKOS}>`, patterns: '', starters: 'πρωινά', character: 'ήσυχη' };
  // Room for every kind's longest answer at once (the default 3000 holds about two server notes).
  const config = withVoice({ maxOutputTokens: 8000 });
  const { messages, sent } = request(queue, { config, oldTextOf: (queued) => olds[queued.kind] });
  assert.deepEqual(sent, queue.map((queued) => queued.id));
  assert.deepEqual(itemsBlock(messages), [
    { id: '1', kind: 'relationship', member: `Ελένη (id:${ELENI})`, old: `παλιά με Νίκος (id:${NIKOS})`, brief: [`μίλησε με Νίκος (id:${NIKOS})`], limit: 600 },
    { id: '2', kind: 'reason', member: `Ελένη (id:${ELENI})`, delta: -3, brief: ['βοήθησε'], limit: 200 },
    { id: '3', kind: 'feeling', member: `Νίκος (id:${NIKOS})`, what: `κέρδισε τη Ελένη (id:${ELENI})`, quote: 'ματ!', brief: ['περήφανος'], limit: 120 },
    { id: '4', kind: 'learned', from: `Νίκος (id:${NIKOS})`, brief: ['το νερό βράζει'], limit: 160 },
    { id: '5', kind: 'self', brief: ['μου αρέσει το τσάι'], limit: 200 },
    { id: '6', kind: 'patterns', brief: ['αστεία'], limit: 2000 },
    { id: '7', kind: 'starters', old: 'πρωινά', brief: ['καλημέρες'], limit: 2000 },
    { id: '8', kind: 'character', member: `Zoë (id:${ZOE})`, old: 'ήσυχη', brief: { keep: ['ήρεμη'], add: [`φίλη του Νίκος (id:${NIKOS})`] }, limit: 1000 },
  ]);
});

test('buildVoiceRequest: items past the token cap are not sent, oldest first kept', () => {
  const long = 'α'.repeat(400); // about 200 tokens each
  const queue = queueOf([0, 1, 2, 3, 4].map((n) => item('self', { brief: [`${n}${long}`] }, NOW + n)));
  const config = makeConfig({ llm: { maxRequestTokens: 900, safetyMargin: 1 } });
  const { messages, sent } = request(dueItems(queue, NOW + 10, config), { config });
  assert.ok(sent.length >= 1 && sent.length < 5, `sent ${sent.length}`);
  assert.deepEqual(sent, queue.slice(0, sent.length).map((queued) => queued.id));
  assert.deepEqual(itemsBlock(messages).map((view) => view.id), sent.map((_, i) => String(i + 1)));
});

test('buildVoiceRequest: an llm.safetyMargin outside (0, 1] still trims the request, at 0.9 as a chat turn does', () => {
  const long = 'α'.repeat(400); // about 200 tokens each
  const queue = queueOf([0, 1, 2, 3, 4].map((n) => item('self', { brief: [`${n}${long}`] }, NOW + n)));
  const sentWith = (llm) => request(queue, { config: makeConfig({ llm }) }).sent;
  const atDefault = sentWith({ maxRequestTokens: 1000, safetyMargin: 0.9 });
  assert.ok(atDefault.length >= 1 && atDefault.length < 5, `sent ${atDefault.length}`);
  assert.ok(sentWith({ maxRequestTokens: 1000, safetyMargin: 1 }).length > atDefault.length, 'a valid margin is applied as given');
  for (const safetyMargin of [0, 1.5, '0.5']) {
    assert.deepEqual(sentWith({ maxRequestTokens: 1000, safetyMargin }), atDefault, String(safetyMargin));
  }
  assert.deepEqual(sentWith({ maxRequestTokens: 1000 }), atDefault, 'a missing margin');
  assert.deepEqual(sentWith({ safetyMargin: 0.9 }), queue.map((queued) => queued.id), 'a missing token cap is config.json\'s 50000');
});

test('buildVoiceRequest: an item too big for the cap is skipped and a later smaller one is still sent', () => {
  const queue = queueOf([
    item('self', { brief: ['μικρό'] }, NOW),
    item('self', { brief: [`μεγάλο ${'α'.repeat(4000)}`] }, NOW + 1),
    item('self', { brief: ['κι άλλο μικρό'] }, NOW + 2),
  ]);
  const config = makeConfig({ llm: { maxRequestTokens: 600, safetyMargin: 1 } });
  const { messages, sent } = request(queue, { config });
  assert.deepEqual(sent, [queue[0].id, queue[2].id]);
  assert.deepEqual(itemsBlock(messages).map((view) => [view.id, view.brief[0]]), [['1', 'μικρό'], ['2', 'κι άλλο μικρό']]);
});

test('buildVoiceRequest: items whose answers would pass memory.voice.maxOutputTokens are not sent', () => {
  const config = withVoice({ maxOutputTokens: 1000 });
  const queue = queueOf([
    item('relationship', { userId: ELENI }, NOW),
    item('relationship', { userId: NIKOS }, NOW + 1),
    item('relationship', { userId: ZOE }, NOW + 2),
    item('feeling', { userId: ZOE, payload: { at: NOW_ISO, date: TODAY, what: 'γέλασε', quote: '' } }, NOW + 3),
  ]);
  const { sent, outputTokens } = request(queue, { config });
  assert.deepEqual(sent, [queue[0].id, queue[1].id, queue[3].id], 'a third 600-char text does not fit what is left; a short feeling still does');
  assert.ok(outputTokens > 0 && outputTokens <= 1000, `${outputTokens}`);
  assert.deepEqual(request(queue, { config: withVoice({ maxOutputTokens: 3000 }) }).sent, queue.map((queued) => queued.id));
});

test('buildVoiceRequest: a lone item over the output budget is still sent alone', () => {
  const config = withVoice({ maxOutputTokens: 100 });
  const queue = queueOf([item('patterns', { brief: ['π'] }, NOW), item('self', { brief: ['ε'] }, NOW + 1)]);
  const { sent, outputTokens } = request(queue, { config });
  assert.deepEqual(sent, [queue[0].id]);
  assert.ok(outputTokens > 100, 'the estimate is reported as it is');
  const empty = request([], { config });
  assert.deepEqual([empty.sent, empty.outputTokens], [[], 0], 'nothing to send, nothing to answer');
});

test('buildVoiceRequest: a private item says so, and its old text is asked for with the item', () => {
  const queue = queueOf([item('relationship', { userId: ELENI, brief: ['στα κρυφά'], layer: 'private' })]);
  let asked;
  const oldTextOf = (queued) => {
    asked = queued;
    return 'ιδιωτικό';
  };
  const { messages } = request(queue, { oldTextOf });
  assert.deepEqual(itemsBlock(messages), [
    { id: '1', kind: 'relationship', member: `Ελένη (id:${ELENI})`, layer: 'private', old: 'ιδιωτικό', brief: ['στα κρυφά'], limit: 600 },
  ]);
  assert.equal(asked.layer, 'private', 'the caller reads the private layer\'s text');
});

test('buildVoiceRequest: a missing prompt throws; the fixed part alone over the cap is a token-limit failure', () => {
  const queue = queueOf([item('self')]);
  assert.throws(() => request(queue, { prompts: { ...PROMPTS, 'memory-voice': '' } }), /memory-voice/);
  const config = makeConfig({ llm: { maxRequestTokens: 10, safetyMargin: 1 } });
  assert.throws(() => request(queue, { config }), SectionsTooLargeError);
});

test('parseVoiceAnswer: ignores ids not sent, empty strings and non-strings', () => {
  const sent = ['q-a', 'q-b', 'q-c'];
  const answer = '```json\n{"items":{"1":" πρώτο ","2":"","3":42,"4":"εφεύρεση","x":"όχι","q-a":"όχι"}}\n```';
  assert.deepEqual([...parseVoiceAnswer(answer, sent)], [['q-a', 'πρώτο']]);
});

test('parseVoiceAnswer: an answer without an items object throws (a bad answer, not a missing item)', () => {
  assert.throws(() => parseVoiceAnswer('{"texts":{}}', ['q-a']));
  assert.throws(() => parseVoiceAnswer('χωρίς json', ['q-a']));
});

test('buildVoiceRetry: the first request, the first answer as an assistant turn, then <over_limit> keyed by request id', () => {
  const queue = queueOf([item('self', { brief: ['α'] }), item('relationship', { userId: ELENI, brief: ['β'] })]);
  const first = request(queue);
  assert.equal(first.messages.length, 2, 'the first request carries no assistant turn');
  assert.ok(!first.messages.some((message) => message.content.includes('<over_limit>')), 'and no <over_limit> block');
  const answer = '{"items":{"1":"εγώ","2":"πολύ μακρύ"}}';
  const messages = buildVoiceRetry(first.messages, answer, [{ id: first.sent[1], chars: 640, limit: 600 }, { id: 'not-sent', chars: 9, limit: 1 }], first.sent);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.slice(0, 2), first.messages);
  assert.deepEqual(messages[2], { role: 'assistant', content: answer });
  assert.equal(messages[3].role, 'user');
  const match = /^<over_limit>\n([\s\S]*)\n<\/over_limit>$/.exec(messages[3].content);
  assert.ok(match, messages[3].content);
  assert.deepEqual(JSON.parse(match[1]), { 2: { chars: 640, limit: 600 } }, 'the id the model saw; an id not sent is left out');
  assert.equal(first.messages.length, 2, 'the first request is not mutated');
});

// ---- applying the answer -----------------------------------------------------------

test('applyVoiceItems: a relationship text is tokenized, clamped and written for the member', () => {
  const queue = queueOf([item('relationship', { userId: ELENI })]);
  const long = `Η Ελένη (id:${ELENI}) ${'και πάλι '.repeat(150)}`;
  const result = applyVoiceItems(new Map([[queue[0].id, long]]), queue, { config: makeConfig(), tokenize });
  assert.equal(result.writes.length, 1);
  const write = result.writes[0];
  assert.deepEqual([write.id, write.kind, write.userId], [queue[0].id, 'relationship', ELENI]);
  assert.ok(write.text.startsWith(`Η <@${ELENI}> και`));
  assert.ok([...write.text].length <= 750, '600 x the 1.25 tolerance');
  assert.deepEqual(result.applied, [queue[0].id]);
  assert.deepEqual(result.byKind, { relationship: 1 });
});

test('applyVoiceItems: a reason item fills the reason of the history entry stage A stamped', () => {
  const queue = queueOf([item('reason', { userId: NIKOS, payload: { delta: 5, at: NOW_ISO } })]);
  const { writes } = applyVoiceItems(new Map([[queue[0].id, 'με βοήθησε']]), queue, { config: makeConfig() });
  assert.deepEqual(writes, [{ id: queue[0].id, kind: 'reason', userId: NIKOS, at: NOW_ISO, text: 'με βοήθησε' }]);
});

test('applyVoiceItems: a feeling item fills the feeling of the episode stage A stored', () => {
  const payload = { at: NOW_ISO, date: TODAY, what: 'κέρδισε', quote: 'ματ!' };
  const queue = queueOf([item('feeling', { userId: NIKOS, payload })]);
  const { writes } = applyVoiceItems(new Map([[queue[0].id, 'χάρηκα πολύ']]), queue, { config: makeConfig() });
  assert.deepEqual(writes, [{ id: queue[0].id, kind: 'feeling', userId: NIKOS, at: NOW_ISO, date: TODAY, what: 'κέρδισε', text: 'χάρηκα πολύ' }]);
});

test('applyVoiceItems: learned, self, patterns and starters become guild writes', () => {
  const queue = queueOf([
    item('learned', { brief: ['μ'], payload: { from: `<@${NIKOS}>`, sure: false, seenAt: NOW - 1 } }),
    item('learned', { brief: ['ν'], payload: {} }, NOW - 7),
    item('self', { brief: ['ε'] }),
    item('patterns', { brief: ['π'] }),
    item('starters', { brief: ['σ'] }),
  ]);
  const worded = new Map(queue.map((queued, i) => [queued.id, `κείμενο ${i}`]));
  const { writes, byKind } = applyVoiceItems(worded, queue, { config: makeConfig() });
  const ids = queue.map((queued) => queued.id);
  assert.deepEqual(writes, [
    { id: ids[0], kind: 'learned', from: `<@${NIKOS}>`, sure: false, seenAt: NOW - 1, text: 'κείμενο 0' },
    { id: ids[1], kind: 'learned', seenAt: NOW - 7, text: 'κείμενο 1' },
    { id: ids[2], kind: 'self', text: 'κείμενο 2' },
    { id: ids[3], kind: 'patterns', text: 'κείμενο 3' },
    { id: ids[4], kind: 'starters', text: 'κείμενο 4' },
  ]);
  assert.deepEqual(byKind, { learned: 2, self: 1, patterns: 1, starters: 1 });
});

test('applyVoiceItems: applies by id, ignores invented ids, reports missing items as still queued', () => {
  const queue = queueOf([item('self', { brief: ['α'] }), item('self', { brief: ['β'] }), item('self', { brief: ['γ'] })]);
  const [a, b, c] = queue.map((queued) => queued.id);
  const worded = new Map([[a, 'πρώτο'], [c, '   '], ['invented', 'όχι']]);
  const result = applyVoiceItems(worded, queue, { config: makeConfig() });
  assert.deepEqual(result.applied, [a]);
  assert.deepEqual(result.missing, [b, c]);
  assert.deepEqual(result.gone, []);
  assert.equal(result.ignored, 1);
  assert.deepEqual(result.writes.map((write) => write.id), [a]);
});

test('applyVoiceItems: an applied character item is reported for the portrait stamps', () => {
  const queue = queueOf([item('character', { userId: ELENI, brief: { add: ['α'] } }), item('character', { userId: NIKOS, brief: { add: ['β'] } })]);
  const result = applyVoiceItems(new Map([[queue[0].id, 'νέο πορτρέτο']]), queue, { config: makeConfig() });
  assert.deepEqual(result.portraits, [ELENI]);
  assert.deepEqual(result.applied, [queue[0].id]);
  assert.deepEqual(result.missing, [queue[1].id]);
  assert.deepEqual(result.writes, [{ id: queue[0].id, kind: 'character', userId: ELENI, text: 'νέο πορτρέτο' }]);
});

test('applyVoiceItems: an item of a forgotten member is gone, worded or not', () => {
  const queue = queueOf([item('relationship', { userId: ZOE }), item('reason', { userId: ZOE, payload: { delta: 1, at: NOW_ISO } }), item('self')]);
  const worded = new Map([[queue[0].id, 'κείμενο'], [queue[2].id, 'εγώ']]);
  const result = applyVoiceItems(worded, queue, { config: makeConfig(), hasMember: (id) => id !== ZOE });
  assert.deepEqual(result.gone, [queue[0].id, queue[1].id]);
  assert.deepEqual(result.applied, [queue[2].id]);
  assert.deepEqual(result.missing, []);
});

test('applyVoiceItems: with features.relationships off a worded relationship or reason is dropped and counted, not written', () => {
  const feeling = item('feeling', { userId: ELENI, payload: { at: NOW_ISO, date: TODAY, what: 'α', quote: '' } });
  const queue = queueOf([item('relationship', { userId: ELENI }), item('reason', { userId: ELENI, payload: { delta: 3, at: NOW_ISO } }), feeling, item('self')]);
  const worded = new Map(queue.map((queued) => [queued.id, 'κείμενο']));
  const result = applyVoiceItems(worded, queue, { config: makeConfig({ features: { relationships: false } }) });
  assert.deepEqual(result.off, [queue[0].id, queue[1].id]);
  assert.deepEqual(result.writes.map((write) => write.kind), ['feeling', 'self']);
  assert.deepEqual([result.missing, result.gone, result.ignored], [[], [], 0]);

  const episodesOff = applyVoiceItems(worded, queue, { config: makeConfig({ features: { episodes: false } }) });
  assert.deepEqual(episodesOff.off, [queue[2].id]);
  assert.deepEqual(episodesOff.byKind, { relationship: 1, reason: 1, self: 1 });
});

test('applyVoiceItems: a private item\'s write carries its layer, and hasMember is asked about that layer', () => {
  const payload = { at: NOW_ISO, date: TODAY, what: 'μυστικό', quote: '' };
  const queue = queueOf([item('relationship', { userId: ELENI, layer: 'private' }), item('feeling', { userId: NIKOS, layer: 'private', payload })]);
  const asked = [];
  const hasMember = (id, layer) => {
    asked.push([id, layer]);
    return id === ELENI;
  };
  const result = applyVoiceItems(new Map(queue.map((queued) => [queued.id, 'κείμενο'])), queue, { config: makeConfig(), hasMember });
  assert.deepEqual(asked, [[ELENI, 'private'], [NIKOS, 'private']]);
  assert.deepEqual(result.writes, [{ id: queue[0].id, kind: 'relationship', userId: ELENI, layer: 'private', text: 'κείμενο' }]);
  assert.deepEqual(result.gone, [queue[1].id]);
});

test('applyVoiceItems: a rewrite over its limit is not written and comes back in overItems; the rest apply', () => {
  const queue = queueOf([item('relationship', { userId: ELENI }), item('patterns', { brief: ['π'] }), item('self', { brief: ['ε'] })]);
  const olds = { relationship: `παλιό με <@${NIKOS}>`, patterns: 'παλιές συνήθειες' };
  const long = `με τη Νίκος (id:${NIKOS}) ${'ά'.repeat(600)}`;
  const worded = new Map([[queue[0].id, long], [queue[1].id, 'ν'.repeat(2000)], [queue[2].id, 'εγώ']]);
  const result = applyVoiceItems(worded, queue, { config: makeConfig(), tokenize, oldTextOf: (queued) => olds[queued.kind] ?? '' });
  const chars = [...tokenize(long)].length;
  assert.deepEqual(result.overItems, [{ id: queue[0].id, chars, limit: 600 }], 'measured after tokenizing, as stored');
  assert.deepEqual(result.writes.map((write) => [write.kind, write.text]), [['patterns', 'ν'.repeat(2000)], ['self', 'εγώ']], 'exactly at the limit is a rewrite');
  assert.deepEqual(result.applied, [queue[1].id, queue[2].id]);
  assert.deepEqual([result.missing, result.gone, result.off], [[], [], []]);
  assert.deepEqual(result.byKind, { patterns: 1, self: 1 });
});

test('applyVoiceItems: a rewrite is never clamped, a first write still is; overItems is empty when nothing overflows', () => {
  const queue = queueOf([item('relationship', { userId: ELENI }), item('relationship', { userId: NIKOS })]);
  const olds = { [ELENI]: 'παλιό' };
  const text = 'λ'.repeat(700);
  const result = applyVoiceItems(new Map([[queue[0].id, 'λ'.repeat(600)], [queue[1].id, text]]), queue, {
    config: makeConfig(),
    oldTextOf: (queued) => olds[queued.userId] ?? '',
  });
  assert.equal(result.writes[0].text, 'λ'.repeat(600));
  assert.ok([...result.writes[1].text].length <= 750 && [...result.writes[1].text].length > 0, 'a first write is clamped with the tolerance');
  assert.deepEqual(result.overItems, []);
});

// ---- the degraded path --------------------------------------------------------------

test('degradedApply: an episode keeps its tone, lessons and self facts are stored from the brief, the rest is dropped', () => {
  const queue = queueOf([
    item('feeling', { userId: NIKOS, brief: ['περήφανος'], payload: { at: NOW_ISO, date: TODAY, what: 'κέρδισε', quote: '' } }),
    item('feeling', { userId: NIKOS, brief: [], payload: { at: NOW_ISO, date: TODAY, what: 'γέλασε', quote: '' } }),
    item('reason', { userId: NIKOS, payload: { delta: 2, at: NOW_ISO } }),
    item('learned', { brief: ['μάθημα'], payload: { seenAt: NOW } }),
    item('self', { brief: ['ισχυρισμός'] }),
    item('relationship', { userId: ELENI }),
    item('patterns', { brief: ['π'] }),
    item('starters', { brief: ['σ'] }),
  ]);
  const ids = queue.map((queued) => queued.id);
  const result = degradedApply(queue, { config: makeConfig() });
  assert.deepEqual(result.writes, [
    { id: ids[0], kind: 'feeling', userId: NIKOS, at: NOW_ISO, date: TODAY, what: 'κέρδισε', text: 'περήφανος' },
    { id: ids[3], kind: 'learned', seenAt: NOW, text: 'μάθημα' },
    { id: ids[4], kind: 'self', text: 'ισχυρισμός' },
  ]);
  assert.deepEqual(result.degraded, [ids[0], ids[3], ids[4]]);
  assert.deepEqual(result.dropped, [ids[1], ids[2], ids[5], ids[6], ids[7]], 'the delta already landed at stage A; markers bring the notes back');
  assert.deepEqual(result.kept, []);
});

test('degradedApply: a character item is never dropped', () => {
  const queue = queueOf([item('character', { userId: ELENI, brief: { add: ['α'] } })]);
  const result = degradedApply(queue, { config: makeConfig() });
  assert.deepEqual(result.kept, [queue[0].id]);
  assert.deepEqual([result.writes, result.dropped, result.degraded], [[], [], []]);
});

test('degradedApply: an item of a forgotten member is dropped, never written', () => {
  const queue = queueOf([
    item('feeling', { userId: ZOE, brief: ['χαρά'], payload: { at: NOW_ISO, date: TODAY, what: 'κέρδισε', quote: '' } }),
    item('feeling', { userId: NIKOS, brief: ['λύπη'], payload: { at: NOW_ISO, date: TODAY, what: 'έχασε', quote: '' } }),
  ]);
  const result = degradedApply(queue, { config: makeConfig(), hasMember: (id) => id !== ZOE });
  assert.deepEqual(result.dropped, [queue[0].id]);
  assert.deepEqual(result.writes.map((write) => [write.userId, write.text]), [[NIKOS, 'λύπη']]);
});

test('degradedApply: a kind switched off is counted off, never written; a private feeling keeps its layer', () => {
  const payload = { at: NOW_ISO, date: TODAY, what: 'μυστικό', quote: '' };
  const queue = queueOf([
    item('feeling', { userId: NIKOS, brief: ['χαρά'], payload }),
    item('feeling', { userId: ELENI, brief: ['εμπιστοσύνη'], layer: 'private', payload }),
    item('self', { brief: ['ε'] }),
  ]);
  const off = degradedApply(queue, { config: makeConfig({ features: { episodes: false } }) });
  assert.deepEqual(off.off, [queue[0].id, queue[1].id]);
  assert.deepEqual(off.writes.map((write) => write.kind), ['self']);
  assert.deepEqual(off.dropped, []);

  const on = degradedApply(queue, { config: makeConfig() });
  assert.deepEqual(on.writes[1], { id: queue[1].id, kind: 'feeling', userId: ELENI, layer: 'private', at: NOW_ISO, date: TODAY, what: 'μυστικό', text: 'εμπιστοσύνη' });
});

// ---- the forced relationship rewrite (`relationshipRewrite`) -----------------
test('splitDecision: a rewrite member gets a relationship item flagged rewrite, with an empty, missing or given brief', () => {
  const decision = {
    users: {
      [ELENI]: { relationship: '' },
      [NIKOS]: { relationship: 'Ο Νίκος (id:222222222222222222) πλησιάζει.' },
    },
  };
  const rewriteIds = new Set([ELENI, NIKOS, ZOE]);
  const { items } = splitDecision(decision, { config: makeConfig(), nowMs: NOW, tokenize, isKnownId, rewriteIds });
  assert.deepEqual(
    items.map(({ kind, userId, brief, rewrite }) => ({ kind, userId, brief, rewrite })),
    [
      { kind: 'relationship', userId: ELENI, brief: [], rewrite: true },
      { kind: 'relationship', userId: NIKOS, brief: [`Ο <@${NIKOS}> πλησιάζει.`], rewrite: true },
      { kind: 'relationship', userId: ZOE, brief: [], rewrite: true },
    ],
    'Zoë has no entry in the answer at all and is still queued',
  );
  for (const queued of items) assert.equal(queued.createdAt, NOW);

  const plain = splitDecision(decision, { config: makeConfig(), nowMs: NOW, tokenize, isKnownId });
  assert.deepEqual(plain.items.map((queued) => [queued.userId, 'rewrite' in queued]), [[NIKOS, false]], 'without rewriteIds nothing changes');
});

test('splitDecision: a rewrite member outside knownUserIds, or with relationships off, gets no item', () => {
  const rewriteIds = new Set([ELENI]);
  const foreign = splitDecision({ users: {} }, { config: makeConfig(), nowMs: NOW, knownUserIds: new Set([NIKOS]), rewriteIds });
  assert.deepEqual(foreign.items, []);
  const off = splitDecision({ users: {} }, { config: makeConfig({ features: { relationships: false } }), nowMs: NOW, rewriteIds });
  assert.deepEqual(off.items, []);
});

test('mergeIntoQueue: a rewrite item keeps its empty brief and its flag, and a merge carries the flag over', () => {
  const config = makeConfig();
  let queue = queueOf([item('relationship', { userId: ELENI, brief: [], rewrite: true })]);
  assert.equal(queue.length, 1);
  assert.deepEqual(queue[0].brief, []);
  assert.equal(queue[0].rewrite, true);
  assert.deepEqual(normalizeQueue(JSON.parse(JSON.stringify(queue))), queue, 'the stored item survives a reload');
  assert.deepEqual(queueOf([item('relationship', { userId: ELENI, brief: [] })]), [], 'an empty brief without the flag is still unusable');

  queue = queueOf([item('relationship', { userId: NIKOS, brief: ['α'] })]);
  const firstId = queue[0].id;
  const merged = mergeIntoQueue(queue, [item('relationship', { userId: NIKOS, brief: [], rewrite: true })], NOW + 1000, config);
  assert.equal(merged.merged, 1);
  assert.equal(merged.queue.length, 1);
  assert.deepEqual(merged.queue[0].brief, ['α']);
  assert.equal(merged.queue[0].rewrite, true);
  assert.notEqual(merged.queue[0].id, firstId, 'the changed item gets a fresh id');
});

test('buildVoiceRequest: a rewrite relationship item says rewrite true beside its old text and brief', () => {
  const queue = queueOf([item('relationship', { userId: ELENI, brief: [], rewrite: true }), item('relationship', { userId: NIKOS, brief: ['β'] })]);
  const { messages } = request(queue, { oldTextOf: () => 'Παλιοί φίλοι.' });
  assert.deepEqual(itemsBlock(messages), [
    { id: '1', kind: 'relationship', member: `Ελένη (id:${ELENI})`, old: 'Παλιοί φίλοι.', rewrite: true, brief: [], limit: 600 },
    { id: '2', kind: 'relationship', member: `Νίκος (id:${NIKOS})`, old: 'Παλιοί φίλοι.', brief: ['β'], limit: 600 },
  ]);
});
