// Tests for the channel handles: the handle of a channel (src/behavior/handles.ts, `#` + `c` +
// base-36 digits of the id's hash, distinct from a member's), a channel a line mentions carrying its handle
// (src/format.ts), her `#handle` becoming `<#id>` (src/memory/mentions.ts#linkChannels) and resolving exactly in a
// skill call (src/tools/executors.ts#resolveCall), the name matching kept behind it, the sandbox carrying a linked
// channel on her line, and the Discord interface's list of readable channels. Pure; fake prompts and config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/operations/index.ts';
import {
  CHANNEL_HANDLE_PREFIX,
  HANDLE_DIGITS,
  assignChannelHandles,
  assignHandles,
  handleOf,
} from '../src/behavior/handles.ts';
import { afterScenarioTurn } from '../src/behavior/sandbox.ts';
import { channelDirectoryOf as guildChannelDirectory } from '../interfaces/discord/index.ts';
import { formatTranscript } from '../src/format.ts';
import { linkChannels } from '../src/memory/mentions.ts';
import { resolveCall } from '../src/tools/executors.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { labels as fixtureLabels } from './fixtures/labels.ts';
import type { Untyped } from '../src/tools/types.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// Two ids whose four-digit hashes collide (the fixture of tests/handles.test.ts).
const OLDER = '400000000000807738';
const NEWER = '400000000005693761';

const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);
const SELF_ID = '900000000000000001';
const GENERAL = '800000000000000101';
const NEWS = '800000000000000202';
const KITCHEN = '800000000000000303';

// Terse test wording for the keys under test (the shipped wording is the dev agent's).
const labels = {
  ...fixtureLabels,
  transcript: { ...fixtureLabels.transcript, channel: '{name} [{handle}]' },
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
    chats: CHANNELS.map(({ id, name }) => ({ id, name })),
    channelHandles: new Map([['c1a2b', KITCHEN]]),
  };
  const read = (channel: Untyped) =>
    // @ts-expect-error: resolveCall reads no `body`, so the key is ignored
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
