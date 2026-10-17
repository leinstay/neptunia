// Tests for the channel handles: the handle of a channel (src/behavior/handles.js, `#` + `c` +
// base-36 digits of the id's hash, distinct from a member's), the channel directory's entries and
// text, `<channel_directory>` in the cached stable part of the persona's request (byte-identical
// between turns), a channel a line mentions carrying its handle (src/format.js), her
// `#handle` becoming `<#id>` (src/memory/mentions.js#linkChannels) and resolving exactly in a
// skill call (src/skills/executors.js#resolveCall), the name matching kept behind it, and the
// sandbox carrying a linked channel on her line. Pure; fake prompts and config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/ops/index.js';
import {
  CHANNEL_HANDLE_PREFIX,
  HANDLE_DIGITS,
  assignChannelHandles,
  assignHandles,
  channelDirectoryEntries,
  handleOf,
  renderChannelDirectory,
} from '../src/behavior/handles.js';
import { buildRequest, userText } from '../src/behavior/prompt.js';
import { afterScenarioTurn } from '../src/behavior/sandbox.js';
import { channelDirectoryOf as guildChannelDirectory } from '../src/discord/collect.js';
import { formatTranscript } from '../src/format.js';
import { withCacheMarker } from '../src/llm/openrouter.js';
import { linkChannels } from '../src/memory/mentions.js';
import { resolveCall } from '../src/skills/executors.js';
import { skillRegistry } from '../src/skills/registry.js';
import { labels as fixtureLabels } from './fixtures/labels.js';

// Two ids whose four-digit hashes collide (the fixture of tests/handles.test.js).
const OLDER = '400000000000807738';
const NEWER = '400000000005693761';

const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);
const MIN = 60_000;
const SELF_ID = '900000000000000001';
const GENERAL = '800000000000000101';
const NEWS = '800000000000000202';
const KITCHEN = '800000000000000303';

// Terse test wording for the keys under test (the shipped wording is the writer's).
const labels = {
  ...fixtureLabels,
  transcript: { ...fixtureLabels.transcript, channel: '{name} [{handle}]' },
  channelDirectory: { lead: 'CHANNELS', line: '{handle} {name}', lineCategory: '{handle} {name} in {category}' },
  directory: { lead: 'DIRECTORY', line: '{handle} {names}' },
};

const CHANNELS = [
  { id: NEWS, name: '💖νέα', category: 'Κοινότητα' },
  { id: GENERAL, name: 'γενικά', category: null },
  { id: KITCHEN, name: 'κουζίνα', category: 'Κοινότητα' },
];

test('channel handles: `c` and four base-36 digits, stable per id, never a member handle', () => {
  const handles = assignChannelHandles([GENERAL, NEWS]);
  assert.match(handles.get(GENERAL), new RegExp(`^${CHANNEL_HANDLE_PREFIX}[0-9a-z]{${HANDLE_DIGITS}}$`));
  assert.equal(handles.get(GENERAL), handleOf(GENERAL, HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX));
  assert.deepEqual(assignChannelHandles([NEWS, GENERAL]), handles, 'the order the ids come in changes nothing');
  assert.notEqual(handles.get(GENERAL), assignHandles({ profiled: [GENERAL] }).get(GENERAL), 'a member handle has another prefix');
  // A collision: the older channel keeps the short form.
  const collided = assignChannelHandles([NEWER, OLDER]);
  assert.equal(collided.get(OLDER), handleOf(OLDER, HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX));
  assert.equal(collided.get(NEWER), handleOf(NEWER, HANDLE_DIGITS + 1, CHANNEL_HANDLE_PREFIX));
});

test('channelDirectoryEntries / renderChannelDirectory: one line per channel by id, the category when known', () => {
  const entries = channelDirectoryEntries([...CHANNELS, { id: GENERAL, name: 'duplicate' }, { id: '1', name: '  ' }, null]);
  assert.deepEqual(entries.map((entry) => entry.id), [GENERAL, NEWS, KITCHEN]);
  const handles = assignChannelHandles(entries.map((entry) => entry.id));
  const text = renderChannelDirectory(entries, handles, labels);
  assert.deepEqual(text.split('\n'), [
    'CHANNELS',
    `#${handles.get(GENERAL)} "γενικά"`,
    `#${handles.get(NEWS)} "💖νέα" in "Κοινότητα"`,
    `#${handles.get(KITCHEN)} "κουζίνα" in "Κοινότητα"`,
  ]);
  assert.equal(renderChannelDirectory(entries, handles, { ...labels, channelDirectory: { line: '' } }), '');
});

test('linkChannels: an exact #handle links its channel first; a name still links behind it', () => {
  const handles = new Map([['c1a2b', KITCHEN]]);
  const known = CHANNELS.map(({ id, name }) => ({ id, name }));
  assert.equal(linkChannels('see #c1a2b and #γενικά', known, handles), `see <#${KITCHEN}> and <#${GENERAL}>`);
  assert.equal(linkChannels('#c1a2b.', [], handles), `<#${KITCHEN}>.`, 'handles alone, without the guild list');
  assert.equal(linkChannels('#c1a2bx #C1A2B https://x.test/#c1a2b', [], handles), '#c1a2bx #C1A2B https://x.test/#c1a2b', 'only the whole token, as shown, never in a URL');
  assert.equal(linkChannels('#c9999 #νέα', known, handles), `#c9999 <#${NEWS}>`, 'an unknown handle stays text; the core match is kept');
});

test('resolveCall: a #handle in a channel argument resolves exactly; the name stays the fallback', () => {
  const view = {
    skills: skillRegistry(),
    conversations: CHANNELS.map(({ id, name }) => ({ id, name })),
    channelHandles: new Map([['c1a2b', KITCHEN]]),
  };
  const read = (channel) => resolveCall({ skill: 'memory.channel.read', args: { channel }, body: '' }, view);
  assert.equal(read('#c1a2b').args.channel, KITCHEN);
  assert.equal(read('c1a2b').args.channel, KITCHEN, 'without its #');
  assert.equal(read('#γενικά').args.channel, GENERAL, 'a name resolves as before');
  assert.equal(read('#c9999').reason, 'args.channel:unknown-channel', 'a handle the request does not hold is never guessed');
  assert.equal(resolveCall({ skill: 'memory.channel.read', args: { channel: '#c1a2b' }, body: '' }, { ...view, channelHandles: null }).reason, 'args.channel:unknown-channel');
});

test('formatTranscript: a mentioned channel carries its handle, as `#name` or a raw <#id>', () => {
  const channels = new Map([[NEWS, { handle: 'c1a2b', name: '💖νέα' }], [GENERAL, { handle: 'c3c4d', name: 'γενικά' }]]);
  const message = {
    id: '1', ts: NOW, authorId: '5', authorName: 'Zoë', self: false, attachments: [], stickers: [], replyToId: null,
    content: `look at #💖νέα, #💖νέας, https://x.test/#💖νέα and <#${GENERAL}>`, mentionedChannelIds: [NEWS],
  };
  const options = { timezone: 'UTC', gapMinutes: 20, maxChars: 800, selfName: 'Nept', labels };
  const [item] = formatTranscript([message], { ...options, channels });
  assert.ok(item.text.endsWith('look at #💖νέα [#c1a2b], #💖νέας, https://x.test/#💖νέα and #γενικά [#c3c4d]'), item.text);
  assert.ok(formatTranscript([message], options)[0].text.endsWith(`and <#${GENERAL}>`), 'no channels: the text as it came');
  assert.ok(formatTranscript([message], { ...options, channels, mode: 'memory' })[0].text.includes('look at #💖νέα,'), 'memory mode never');
});

function input(overrides = {}) {
  const author = { id: '650000000000000123', names: ['Zoë'] };
  const history = overrides.history ?? [
    { id: '1', ts: NOW - 2 * MIN, authorId: author.id, authorName: 'Zoë', self: false, content: 'in #κουζίνα now', mentionedChannelIds: [KITCHEN], attachments: [], stickers: [], replyToId: null },
  ];
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: {
        gapMarkerMinutes: 20,
        maxMessageChars: 800,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
        vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
        tempo: { liveMessages10min: 4, deadSilenceMinutes: 45 },
      },
      features: { vision: true },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      lore: { scanMessages: 30, maxMatches: 8 },
      memory: { recentHours: 72 },
    },
    prompts: { 'system-prompt': 'SYSTEM', 'character-card': 'CARD', rules: 'RULES', format: 'FORMAT', reply: 'REPLY to {{author}}', labels },
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
    candidateProfiles: [author],
    channelDirectory: CHANNELS,
    ...overrides,
  };
}

const stableOf = (request) => request.messages[1].content.find((part) => part.cacheSegment === 'stable')?.text ?? '';
const channelDirectoryOf = (text) => /<channel_directory>\n([\s\S]*?)\n<\/channel_directory>/.exec(text)?.[1] ?? null;

test('buildRequest: <channel_directory> sits in the cached stable part, before <directory>, and carries the marker', () => {
  const request = buildRequest(input());
  const stable = stableOf(request);
  const body = channelDirectoryOf(stable);
  assert.ok(body, stable);
  assert.ok(stable.indexOf('<channel_directory>') < stable.indexOf('<directory>'), 'before the people directory');
  const handles = assignChannelHandles(CHANNELS.map((channel) => channel.id));
  assert.equal(body.split('\n').length, 1 + CHANNELS.length);
  assert.ok(body.includes(`#${handles.get(KITCHEN)} "κουζίνα" in "Κοινότητα"`), body);
  // The stable part is the one that carries the provider's cache marker.
  const sent = withCacheMarker(request.messages, '1h');
  const part = sent[1].content.find((p) => p.type === 'text' && p.text.includes('<channel_directory>'));
  assert.ok(part?.cache_control, 'the part holding the channel directory is marked');
  assert.equal(part.text, stable);
  const tail = request.messages[1].content.find((p) => p.type === 'text' && !p.cacheSegment);
  assert.ok(!tail.text.includes('<channel_directory>'), 'never in the tail');
  // Her handle maps back to the channel.
  assert.equal(request.channelHandles.get(handles.get(KITCHEN)), KITCHEN);
});

test('buildRequest: the channel directory is byte-identical across turns with another clock, chat and channel order', () => {
  const first = buildRequest(input());
  const laterHistory = [
    { id: '7', ts: NOW + 50 * MIN, authorId: '650000000000000777', authorName: 'Léo', self: false, content: 'hi', attachments: [], stickers: [], replyToId: null },
  ];
  const second = buildRequest(input({ now: NOW + 90 * MIN, history: laterHistory, trigger: laterHistory[0], channelDirectory: [...CHANNELS].reverse() }));
  assert.equal(channelDirectoryOf(stableOf(second)), channelDirectoryOf(stableOf(first)));
  assert.equal(stableOf(second), stableOf(first));
});

test('buildRequest: a channel a chat line mentions shows its handle; off with features.mentionHandles off', () => {
  const handles = assignChannelHandles(CHANNELS.map((channel) => channel.id));
  const text = userText(buildRequest(input()).messages[1].content);
  assert.ok(text.includes(`in #κουζίνα [#${handles.get(KITCHEN)}] now`), text);
  const off = buildRequest(input({ config: { ...input().config, features: { vision: true, mentionHandles: false } } }));
  const offText = userText(off.messages[1].content);
  assert.equal(channelDirectoryOf(offText), null);
  assert.ok(offText.includes('in #κουζίνα now'), offText);
  assert.equal(off.channelHandles, null);
  assert.equal(buildRequest(input({ channelDirectory: [] })).channelHandles, null, 'no channel given, no map');
});

test('afterScenarioTurn: her #handle lands on her line as the channel link a live post makes', () => {
  const here = { id: GENERAL, name: 'γενικά' };
  const run = {
    answer: { messages: [{ text: 'over in #c1a2b', replyTo: null }], reactions: [], gif: null, draw: null, skip: false, think: '' },
    call: null, outcome: null, followUp: null,
    refs: { idByIndex: new Map(), handles: null, channelHandles: new Map([['c1a2b', KITCHEN]]), followUpIdByIndex: null },
  };
  const out = afterScenarioTurn({ transcript: [], callMarks: [], run, at: NOW, selfId: SELF_ID, selfName: 'Nept', channel: here, config: {} });
  const [mine] = out.transcript;
  assert.equal(mine.content, `over in <#${KITCHEN}>`);
  assert.deepEqual(mine.mentionedChannelIds, [KITCHEN]);
});

test('channelDirectoryOf: the readable text channels with their category, never a thread', () => {
  const guild = { members: { me: { id: SELF_ID } } };
  const channel = (id, name, { thread = false, parent = null, readable = true } = {}) => ({
    id, name, guild, viewable: true, parent,
    isTextBased: () => true,
    isThread: () => thread,
    permissionsFor: () => ({ has: () => readable }),
  });
  guild.channels = {
    cache: new Map([
      [GENERAL, channel(GENERAL, 'γενικά')],
      [NEWS, channel(NEWS, '💖νέα', { parent: { name: 'Κοινότητα' } })],
      ['800000000000000404', channel('800000000000000404', 'ένα νήμα', { thread: true, parent: { name: 'γενικά' } })],
      ['800000000000000505', channel('800000000000000505', 'κρυφό', { readable: false })],
    ]),
  };
  assert.deepEqual(guildChannelDirectory(guild, {}), [
    { id: GENERAL, name: 'γενικά', category: null },
    { id: NEWS, name: '💖νέα', category: 'Κοινότητα' },
  ]);
  assert.deepEqual(guildChannelDirectory(null, {}), [], 'a private chat has none');
});
