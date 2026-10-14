// Tests for the people directory and the mention handles in src/behavior/prompt.js#buildRequest
// (features.mentionHandles): `<directory>` last in the cached stable part, byte-identical between
// turns, requesters and channels; each author in view carrying their handle on their lines
// (src/discord/format.js, `transcript.author`); the request's handle -> member id map; nothing of
// it with the switch off. Fake prompts and config; the fixture labels plus the keys under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, userText } from '../src/behavior/prompt.js';
import { assignHandles, handleOf } from '../src/behavior/handles.js';
import { estimateTokens } from '../src/llm/tokens.js';
import { labels as fixtureLabels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);
const MIN = 60_000;
const SELF_ID = '900000000000000001';

// Terse test wording for the keys under test (the shipped wording is the writer's).
const labels = {
  ...fixtureLabels,
  transcript: { ...fixtureLabels.transcript, author: '{name} [{handle}]' },
  directory: { lead: 'DIRECTORY', line: '{handle} {names}', lineAliases: '{handle} {names} aka {aliases}' },
};

// 23 members, as a mid-sized server keeps them: one to three names, up to three aliases, some closed.
const NAMES = [
  ['Ἀλκμήνη'], ['Zoé', 'Zoé ✿'], ['Léo Martin'], ['Ταξιάρχης'], ['Anaïs', 'anaïs_42'], ['Bérénice'], ['Δημήτρης'],
  ['Élodie', 'Élo'], ['François'], ['Ἑλένη', 'Helena'], ['Inès'], ['Jérôme', 'J.'], ['Κωνσταντίνος'], ['Loïc'],
  ['Maëlle', 'Maëlle (away)', 'mae'], ['Νίκος'], ['Océane'], ['Pénélope'], ['Ρένα'], ['Sébastien'], ['Σοφία'],
  ['Thaïs'], ['Ulysse'],
];
const ALIASES = [['Ἀλκ'], [], ['Léo', 'Martinou'], ['Ταξ'], [], ['Béré', 'Nice'], [], ['Lodie'], ['Franz'], ['Λένα'], [], ['Jéjé'], ['Κώστας', 'Ντίνος'], [], ['Maë'], [], ['Océ'], ['Pénny'], [], ['Séb', 'Bastien'], ['Σόφη'], [], ['Ulyx']];
const PROFILES = NAMES.map((names, i) => ({
  id: String(700000000000000000n + BigInt(i) * 7_340_033n),
  names,
  aliases: [...ALIASES[i].map((name) => ({ name, weight: 3 })), ...(i % 5 === 0 ? [{ name: 'Old nick', weight: 1, validTo: '2026-01-01' }] : [])],
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

function line(id, minutesAgo, author, overrides = {}) {
  return { id, ts: NOW - minutesAgo * MIN, authorId: author.id, authorName: author.names?.[0] ?? author.name, self: false, content: `line ${id}`, attachments: [], stickers: [], replyToId: null, ...overrides };
}

const STRANGER = { id: '650000000000000123', name: 'Passer-by' };
const BOT = { id: '650000000000000999', name: 'HelperBot' };

function input(overrides = {}) {
  const history = overrides.history ?? [line('1', 3, PROFILES[0]), line('2', 2, STRANGER), line('3', 1, PROFILES[1])];
  return {
    config: fakeConfig(),
    prompts: { 'system-prompt': 'SYSTEM', 'character-card': 'CARD', rules: 'RULES', format: 'FORMAT', reply: 'REPLY to {{author}}', interject: 'INTERJECT', labels },
    calibrator: { ratio: 1, apply: (n) => n },
    mode: 'reply',
    now: NOW,
    selfName: 'Nept',
    selfId: SELF_ID,
    history,
    neighbors: [],
    trigger: history.at(-1),
    triggerKind: 'mention',
    guildMemory: {},
    interlocutor: null,
    otherProfiles: [],
    candidateProfiles: [...PROFILES, SELF_PROFILE],
    ...overrides,
  };
}

const stableOf = (request) => request.messages[1].content.find((part) => part.cacheSegment === 'stable')?.text ?? '';
const directoryOf = (text) => /<directory>\n([\s\S]*?)\n<\/directory>/.exec(text)?.[1] ?? null;

test('buildRequest: <directory> lists every profiled member but the persona, last in the stable part', () => {
  const request = buildRequest(input());
  const stable = stableOf(request);
  const body = directoryOf(stable);
  assert.ok(body, stable);
  assert.ok(stable.trimEnd().endsWith('</directory>'), 'the last block of the stable part');
  const lines = body.split('\n');
  assert.equal(lines[0], 'DIRECTORY');
  assert.equal(lines.length, 1 + PROFILES.length, 'one line per member, never the persona');
  assert.ok(!body.includes('"Nept"'));
  const handles = assignHandles({ profiled: PROFILES.map((profile) => profile.id) });
  const zoe = PROFILES[1];
  assert.ok(lines.includes(`@${handles.get(zoe.id)} "Zoé", "Zoé ✿"`), body);
  const leo = PROFILES[2];
  assert.ok(lines.includes(`@${handles.get(leo.id)} "Léo Martin" aka "Léo", "Martinou"`), body);
  assert.ok(!body.includes('Old nick'), 'a closed alias is not listed');
  assert.ok(!body.includes('never shows'), 'no notes, no games');
});

test('buildRequest: the stable part is byte-identical between turns, requesters and channels', () => {
  const first = buildRequest(input());
  const otherHistory = [line('7', 9, PROFILES[5]), line('8', 4, STRANGER, { authorId: '650000000000000777', authorName: 'Someone else' }), line('9', 1, PROFILES[12])];
  const second = buildRequest(
    input({
      history: otherHistory,
      trigger: otherHistory.at(-1),
      currentChannelId: 'another-channel',
      interlocutor: PROFILES[12],
      neighbors: [{ channelId: 'n1', channelName: 'next-door', messages: [line('n1', 2, PROFILES[7])] }],
    }),
  );
  const interject = buildRequest(input({ mode: 'interject', trigger: null, triggerKind: null }));
  // The stored order of a member's names (the newest first) moves with every message they post.
  const reordered = buildRequest(input({ candidateProfiles: [...PROFILES].reverse().map((profile) => ({ ...profile, names: [...profile.names].reverse(), aliases: [...profile.aliases].reverse() })) }));
  assert.ok(directoryOf(stableOf(first)));
  assert.equal(stableOf(second), stableOf(first));
  assert.equal(stableOf(interject), stableOf(first));
  assert.equal(stableOf(reordered), stableOf(first));
});

test('buildRequest: a new alias changes the directory line of that member only', () => {
  const first = directoryOf(stableOf(buildRequest(input()))).split('\n');
  const changed = PROFILES.map((profile, i) => (i === 3 ? { ...profile, aliases: [...profile.aliases, { name: 'Τάκης', weight: 2 }] } : profile));
  const second = directoryOf(stableOf(buildRequest(input({ candidateProfiles: changed })))).split('\n');
  assert.equal(second.length, first.length);
  assert.deepEqual(
    second.filter((text, i) => text !== first[i]).map((text) => text.includes('Τάκης')),
    [true],
  );
});

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
  assert.equal(request.handles.get(handleOf(STRANGER.id)), STRANGER.id, 'a member without a profile is taggable');
  assert.equal(request.handles.get(profiled.get(PROFILES[0].id)), PROFILES[0].id);
  assert.equal([...request.handles.values()].includes(BOT.id), false, 'a bot gets no handle');
  assert.equal([...request.handles.values()].includes(SELF_ID), false, 'the persona gets no handle');
  assert.equal(request.handles.size, PROFILES.length + 1);
});

test('buildRequest: the authors of the pulled lines and the neighbours get handles; a private chat sees only its chat', () => {
  const neighbor = { id: '650000000000000555', name: 'Neighbour' };
  const pulledAuthor = { id: '650000000000000556', name: 'Pulled' };
  const extra = {
    neighbors: [{ channelId: 'n1', channelName: 'next-door', messages: [line('n1', 2, neighbor)] }],
    pulled: [{ channelId: 'p1', channelName: 'elsewhere', messages: [line('p1', 2, pulledAuthor)] }],
  };
  const server = buildRequest(input(extra));
  assert.equal(server.handles.get(handleOf(neighbor.id)), neighbor.id);
  assert.equal(server.handles.get(handleOf(pulledAuthor.id)), pulledAuthor.id);
  const dm = buildRequest(input({ ...extra, privateChat: { userId: PROFILES[1].id } }));
  assert.equal(dm.handles.has(handleOf(neighbor.id)), false);
  assert.equal(dm.handles.has(handleOf(pulledAuthor.id)), false);
  assert.ok(directoryOf(stableOf(dm)), 'the directory is in a private chat too');
});

test('buildRequest: features.mentionHandles off -- no directory, no handles on the lines, no map', () => {
  const request = buildRequest(input({ config: fakeConfig({ mentionHandles: false }) }));
  const text = userText(request.messages[1].content);
  assert.equal(directoryOf(text), null);
  assert.ok(text.includes('Passer-by: line 2'), text);
  assert.equal(request.handles, null);
});

test('buildRequest: without the directory labels no block, and without transcript.author bare names', () => {
  const request = buildRequest(input({ prompts: { ...input().prompts, labels: fixtureLabels } }));
  const text = userText(request.messages[1].content);
  assert.equal(directoryOf(text), null);
  assert.ok(text.includes('Passer-by: line 2'), text);
  assert.ok(request.handles instanceof Map, 'the handles still resolve');
});

test('buildRequest: the directory of 23 members stays small (chars and estimated tokens reported)', (t) => {
  const body = directoryOf(stableOf(buildRequest(input())));
  const block = `<directory>\n${body}\n</directory>`;
  const tokens = estimateTokens(block);
  // The figure the task asked for; the bound only guards against a runaway format.
  t.diagnostic(`directory: ${block.length} chars, ~${tokens} tokens`);
  assert.ok(block.length < 2000, `${block.length} chars`);
});
