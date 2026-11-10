// Tests for the mention handles in src/behavior/prompt.ts#buildRequest: each author in view carrying their handle on
// their lines (src/format.ts, `transcript.author`), the request's handle -> member id map, and no `<directory>` block. Fake prompts and config; the fixture labels plus the keys under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userText } from '../src/behavior/prompt.ts';
import { assignHandles, handleOf } from '../src/behavior/handles.ts';
import { labels as fixtureLabels } from './fixtures/labels.ts';
import { buildRequest } from './fixtures/built-request.ts';
import { frameOfInput } from './fixtures/prompt-rig.ts';

const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);
const MIN = 60_000;
const SELF_ID = '900000000000000001';

// Terse test wording for the keys under test (the shipped wording is the dev agent's).
const labels = {
  ...fixtureLabels,
  transcript: { ...fixtureLabels.transcript, author: '{name} [{handle}]' },
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
    lore: { scanMessages: 30, maxMatches: 8 },
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
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      reply: 'REPLY to {{author}}',
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

test('buildRequest: every author in view carries a handle on their lines; the persona and bots do not', () => {
  const history = [
    line('1', 4, PROFILES[0]),
    line('2', 3, STRANGER),
    line('3', 2, BOT, { bot: true }),
    line('4', 1, { id: SELF_ID, name: 'Nept' }, { self: true }),
  ];
  const request = buildRequest(input({ history, trigger: history[1] }));
  const text = userText(request.messages[1].content);
  const profiled = assignHandles({ profiled: PROFILES.map((profile) => profile.id) });
  assert.ok(text.includes(`Ἀλκμήνη [@${profiled.get(PROFILES[0].id)}]: line 1`), text);
  assert.ok(text.includes(`Passer-by [@${handleOf(STRANGER.id)}]: line 2`), text);
  assert.ok(text.includes('HelperBot: line 3'), text);
  assert.ok(text.includes('Nept (you): line 4'), text);
  assert.equal(request.handles!.get(handleOf(STRANGER.id)), STRANGER.id, 'a member without a profile is taggable');
  assert.equal(request.handles!.get(profiled.get(PROFILES[0].id)!), PROFILES[0].id);
  assert.equal([...request.handles!.values()].includes(BOT.id), false, 'a bot gets no handle');
  assert.equal([...request.handles!.values()].includes(SELF_ID), false, 'the persona gets no handle');
  // Slice 7: no directory up front (the lead's decision 3), so the handles are those of the people in the request: the
  // profiled author and the stranger, not every profiled member.
  assert.equal(request.handles!.size, 2);
});
