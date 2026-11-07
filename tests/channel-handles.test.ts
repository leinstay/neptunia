// Tests for the channel handles: the handle of a channel (src/behavior/handles.ts, `#` + `c` +
// base-36 digits of the id's hash, distinct from a member's), the channel directory's entries and
// text, `<channel_directory>` in the cached stable part of the persona's request (byte-identical
// between turns), a channel a line mentions carrying its handle (src/format.ts), her
// `#handle` becoming `<#id>` (src/memory/mentions.ts#linkChannels) and resolving exactly in a
// skill call (src/tools/executors.ts#resolveCall), the name matching kept behind it, and the
// sandbox carrying a linked channel on her line. Pure; fake prompts and config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/impl/index.ts';
import {
  CHANNEL_HANDLE_PREFIX,
  HANDLE_DIGITS,
  assignChannelHandles,
  assignHandles,
  channelDirectoryEntries,
  handleOf,
  renderChannelDirectory,
} from '../src/behavior/handles.ts';
import { buildRequest, userText } from '../src/behavior/prompt.ts';
import { afterScenarioTurn } from '../src/behavior/sandbox.ts';
import { channelDirectoryOf as guildChannelDirectory } from '../interfaces/discord/index.ts';
import { formatTranscript } from '../src/format.ts';
import { withCacheMarker } from '../src/llm/openrouter.ts';
import { linkChannels } from '../src/memory/mentions.ts';
import { resolveCall } from '../src/tools/executors.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { labels as fixtureLabels } from './fixtures/labels.ts';
import type { Untyped } from '../src/tools/types.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// The stand-ins hold only the part of the real input that the code under test reads, so each is cast once, here.
const fakeOf = <T>(value: object): T => value as T;
type BuildInput = Parameters<typeof buildRequest>[0];

// Two ids whose four-digit hashes collide (the fixture of tests/handles.test.ts).
const OLDER = '400000000000807738';
const NEWER = '400000000005693761';

const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);
const MIN = 60_000;
const SELF_ID = '900000000000000001';
const GENERAL = '800000000000000101';
const NEWS = '800000000000000202';
const KITCHEN = '800000000000000303';

// Terse test wording for the keys under test (the shipped wording is the dev agent's).
const labels = {
  ...fixtureLabels,
  transcript: { ...fixtureLabels.transcript, channel: '{name} [{handle}]' },
  channelDirectory: { lead: 'CHANNELS', line: '{handle} {name}' },
  directory: { lead: 'DIRECTORY', line: '{handle} {names}' },
};

const CHANNELS = [
  { id: NEWS, name: '💖νέα' },
  { id: GENERAL, name: 'γενικά' },
  { id: KITCHEN, name: 'κουζίνα', category: 'Κοινότητα' },
];

test('channel handles: `c` and four base-36 digits, stable per id, never a member handle', () => {
  const handles = assignChannelHandles([GENERAL, NEWS]);
  // @ts-expect-error: the map holds a handle for every id it was built from
  assert.match(handles.get(GENERAL), new RegExp(`^${CHANNEL_HANDLE_PREFIX}[0-9a-z]{${HANDLE_DIGITS}}$`));
  assert.equal(handles.get(GENERAL), handleOf(GENERAL, HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX));
  assert.deepEqual(assignChannelHandles([NEWS, GENERAL]), handles, 'the order the ids come in changes nothing');
  assert.notEqual(
    handles.get(GENERAL),
    assignHandles({ profiled: [GENERAL] }).get(GENERAL),
    'a member handle has another prefix'
  );
  // A collision: the older channel keeps the short form.
  const collided = assignChannelHandles([NEWER, OLDER]);
  assert.equal(collided.get(OLDER), handleOf(OLDER, HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX));
  assert.equal(collided.get(NEWER), handleOf(NEWER, HANDLE_DIGITS + 1, CHANNEL_HANDLE_PREFIX));
});

test('channelDirectoryEntries / renderChannelDirectory: one line per channel by id, no category', () => {
  // A category is no place, the owner's word of 2026-11-06.
  // @ts-expect-error: the test adds malformed entries (a duplicate, a blank name, null) on purpose
  const entries = channelDirectoryEntries([
    ...CHANNELS,
    { id: GENERAL, name: 'duplicate' },
    { id: '1', name: '  ' },
    null,
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [GENERAL, NEWS, KITCHEN]
  );
  const handles = assignChannelHandles(entries.map((entry) => entry.id));
  const text = renderChannelDirectory(entries, handles, labels);
  assert.deepEqual(text.split('\n'), [
    'CHANNELS',
    `#${handles.get(GENERAL)} "γενικά"`,
    `#${handles.get(NEWS)} "💖νέα"`,
    `#${handles.get(KITCHEN)} "κουζίνα"`,
  ]);
  assert.equal(renderChannelDirectory(entries, handles, { ...labels, channelDirectory: { line: '' } }), '');
});

test('linkChannels: an exact #handle links its channel first; a name still links behind it', () => {
  const handles = new Map([['c1a2b', KITCHEN]]);
  const known = CHANNELS.map(({ id, name }) => ({ id, name }));
  assert.equal(linkChannels('see #c1a2b and #γενικά', known, handles), `see <#${KITCHEN}> and <#${GENERAL}>`);
  assert.equal(linkChannels('#c1a2b.', [], handles), `<#${KITCHEN}>.`, 'handles alone, without the guild list');
  assert.equal(
    linkChannels('#c1a2bx #C1A2B https://x.test/#c1a2b', [], handles),
    '#c1a2bx #C1A2B https://x.test/#c1a2b',
    'only the whole token, as shown, never in a URL'
  );
  assert.equal(
    linkChannels('#c9999 #νέα', known, handles),
    `#c9999 <#${NEWS}>`,
    'an unknown handle stays text; the core match is kept'
  );
});

test('resolveCall: a #handle in a channel argument resolves exactly; the name stays the fallback', () => {
  const view = {
    skills: skillRegistry(),
    conversations: CHANNELS.map(({ id, name }) => ({ id, name })),
    channelHandles: new Map([['c1a2b', KITCHEN]]),
  };
  // @ts-expect-error: resolveCall reads no `body`, so the key is ignored
  const read = (channel: Untyped) =>
    resolveCall({ skill: 'memory.channel.read', args: { place: channel }, body: '' }, view);
  assert.equal(loose(read('#c1a2b')).args.place, KITCHEN);
  assert.equal(loose(read('c1a2b')).args.place, KITCHEN, 'without its #');
  assert.equal(loose(read('#γενικά')).args.place, GENERAL, 'a name resolves as before');
  assert.equal(
    loose(read('#c9999')).reason,
    'args.place:unknown-channel',
    'a handle the request does not hold is never guessed'
  );
  assert.equal(
    loose(
      resolveCall(
        // @ts-expect-error: resolveCall reads no `body`, so the key is ignored
        { skill: 'memory.channel.read', args: { place: '#c1a2b' }, body: '' },
        { ...view, channelHandles: null }
      )
    ).reason,
    'args.place:unknown-channel'
  );
});

test('formatTranscript: a mentioned channel carries its handle, as `#name` or a raw <#id>', () => {
  const channels = new Map([
    [NEWS, { handle: 'c1a2b', name: '💖νέα' }],
    [GENERAL, { handle: 'c3c4d', name: 'γενικά' }],
  ]);
  const message = {
    id: '1',
    ts: NOW,
    authorId: '5',
    authorName: 'Zoë',
    self: false,
    attachments: [],
    stickers: [],
    replyToId: null,
    content: `look at #💖νέα, #💖νέας, https://x.test/#💖νέα and <#${GENERAL}>`,
    mentionedChannelIds: [NEWS],
  };
  const options = { timezone: 'UTC', gapMinutes: 20, maxChars: 800, selfName: 'Nept', labels };
  const [item] = formatTranscript([message], { ...options, channels });
  assert.ok(
    item.text.endsWith('look at #💖νέα [#c1a2b], #💖νέας, https://x.test/#💖νέα and #γενικά [#c3c4d]'),
    item.text
  );
  assert.ok(
    formatTranscript([message], options)[0].text.endsWith(`and <#${GENERAL}>`),
    'no channels: the text as it came'
  );
  assert.ok(
    formatTranscript([message], { ...options, channels, mode: 'memory' })[0].text.includes('look at #💖νέα,'),
    'memory mode never'
  );
});

function input(overrides: Record<string, unknown> = {}): BuildInput {
  const author = { id: '650000000000000123', names: ['Zoë'] };
  const history = (loose(overrides).history as Array<Record<string, unknown>> | undefined) ?? [
    {
      id: '1',
      ts: NOW - 2 * MIN,
      authorId: author.id,
      authorName: 'Zoë',
      self: false,
      content: 'in #κουζίνα now',
      mentionedChannelIds: [KITCHEN],
      attachments: [],
      stickers: [],
      replyToId: null,
    },
  ];
  return fakeOf<BuildInput>({
    config: {
      bot: { timezone: 'UTC' },
      context: {
        gapMarkerMinutes: 20,
        maxMessageChars: 800,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
        vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
        tempo: { liveMessages10min: 4, deadSilenceMinutes: 45 },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      lore: { scanMessages: 30, maxMatches: 8 },
      memory: { recentHours: 72 },
    },
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      reply: 'REPLY to {{author}}',
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
    candidateProfiles: [author],
    channelDirectory: CHANNELS,
    ...overrides,
  });
}

type Part = { type?: string; text?: string; cacheSegment?: string; cache_control?: unknown };
type Request = ReturnType<typeof buildRequest>;
// The user message of a request is a list of parts; its type also allows a plain string.
const partsOf = (content: unknown) => content as Array<Part>;
const stableOf = (request: Request) =>
  partsOf(request.messages[1].content).find((part) => part.cacheSegment === 'stable')?.text ?? '';
const channelDirectoryOf = (text: string) =>
  /<channel_directory>\n([\s\S]*?)\n<\/channel_directory>/.exec(text)?.[1] ?? null;

test('buildRequest: <channel_directory> sits in the cached stable part, before <directory>, and carries the marker', () => {
  const request = buildRequest(input());
  const stable = stableOf(request);
  const body = channelDirectoryOf(stable);
  assert.ok(body, stable);
  assert.ok(stable.indexOf('<channel_directory>') < stable.indexOf('<directory>'), 'before the people directory');
  const handles = assignChannelHandles(CHANNELS.map((channel) => channel.id));
  assert.equal(body.split('\n').length, 1 + CHANNELS.length);
  assert.ok(body.includes(`#${handles.get(KITCHEN)} "κουζίνα"`), body);
  // The stable part is the one that carries the provider's cache marker.
  const sent = withCacheMarker(request.messages, '1h');
  const part = partsOf(sent[1].content).find((p) => p.type === 'text' && p.text?.includes('<channel_directory>'));
  assert.ok(part?.cache_control, 'the part holding the channel directory is marked');
  assert.equal(part?.text, stable);
  const tail = partsOf(request.messages[1].content).find((p) => p.type === 'text' && !p.cacheSegment);
  assert.ok(!tail?.text?.includes('<channel_directory>'), 'never in the tail');
  // Her handle maps back to the channel.
  assert.equal(request.channelHandles?.get(handles.get(KITCHEN) ?? ''), KITCHEN);
});

test('buildRequest: the channel directory is byte-identical across turns with another clock, chat and channel order', () => {
  const first = buildRequest(input());
  const laterHistory = [
    {
      id: '7',
      ts: NOW + 50 * MIN,
      authorId: '650000000000000777',
      authorName: 'Léo',
      self: false,
      content: 'hi',
      attachments: [],
      stickers: [],
      replyToId: null,
    },
  ];
  const second = buildRequest(
    input({
      now: NOW + 90 * MIN,
      history: laterHistory,
      trigger: laterHistory[0],
      channelDirectory: [...CHANNELS].reverse(),
    })
  );
  assert.equal(channelDirectoryOf(stableOf(second)), channelDirectoryOf(stableOf(first)));
  assert.equal(stableOf(second), stableOf(first));
});

test('buildRequest: a channel a chat line mentions shows its handle', () => {
  const handles = assignChannelHandles(CHANNELS.map((channel) => channel.id));
  const text = userText(buildRequest(input()).messages[1].content);
  assert.ok(text.includes(`in #κουζίνα [#${handles.get(KITCHEN)}] now`), text);
  assert.equal(buildRequest(input({ channelDirectory: [] })).channelHandles, null, 'no channel given, no map');
});

test('afterScenarioTurn: her #handle lands on her line as the channel link a live post makes', () => {
  const here = { id: GENERAL, name: 'γενικά' };
  const run = {
    answer: {
      messages: [{ text: 'over in #c1a2b', replyTo: null }],
      reactions: [],
      gif: null,
      draw: null,
      skip: false,
      think: '',
    },
    call: null,
    outcome: null,
    followUp: null,
    refs: {
      idByIndex: new Map(),
      handles: null,
      channelHandles: new Map([['c1a2b', KITCHEN]]),
      followUpIdByIndex: null,
    },
  };
  const out = afterScenarioTurn({
    transcript: [],
    callMarks: [],
    // @ts-expect-error: the run stand-in holds only the part afterScenarioTurn reads
    run,
    at: NOW,
    selfId: SELF_ID,
    selfName: 'Nept',
    channel: here,
    config: {},
  });
  const [mine] = out.transcript;
  assert.equal(loose(mine).content, `over in <#${KITCHEN}>`);
  assert.deepEqual(loose(mine).mentionedChannelIds, [KITCHEN]);
});

test('channelDirectoryOf: the readable text channels, never a thread', () => {
  // A category is no place, the owner's word of 2026-11-06.
  const guild = { members: { me: { id: SELF_ID } } };
  const channel = (
    id: string,
    name: string,
    {
      thread = false,
      parent = null,
      readable = true,
    }: { thread?: boolean; parent?: { name: string } | null; readable?: boolean } = {}
  ) => ({
    id,
    name,
    guild,
    viewable: true,
    parent,
    isTextBased: () => true,
    isThread: () => thread,
    permissionsFor: () => ({ has: () => readable }),
  });
  loose(guild).channels = {
    cache: new Map([
      [GENERAL, channel(GENERAL, 'γενικά')],
      [NEWS, channel(NEWS, '💖νέα', { parent: { name: 'Κοινότητα' } })],
      ['800000000000000404', channel('800000000000000404', 'ένα νήμα', { thread: true, parent: { name: 'γενικά' } })],
      ['800000000000000505', channel('800000000000000505', 'κρυφό', { readable: false })],
    ]),
  };
  // @ts-expect-error: guildChannelDirectory takes one argument; the second is ignored
  assert.deepEqual(guildChannelDirectory(guild, {}), [
    { id: GENERAL, name: 'γενικά' },
    { id: NEWS, name: '💖νέα' },
  ]);
  // @ts-expect-error: guildChannelDirectory takes one argument; the second is ignored
  assert.deepEqual(guildChannelDirectory(null, {}), [], 'a private chat has none');
});
