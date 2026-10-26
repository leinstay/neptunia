// The four permission booleans of a conversation as the Discord adapter reports them (`conversationInfo`), against
// the old `canRead`, `canSend`, `canAttach` and `canReact` of interfaces/discord/collect.js over every branch: a
// channel without a guild, an unviewable one, no member `me`, no resolved permissions, and each flag alone and together.
// A false boolean makes the persona go quiet, so each row also names the literal answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { canAttach, canReact, canRead, canSend, createDiscordAdapter } from '../interfaces/discord/index.js';

type Raw = Record<string, unknown>;
type Granted = ReadonlyArray<bigint>;

const SELF = { id: 'self-id' };
const EVERYONE = { id: 'g1' };

function guildChannel(options: { granted?: Granted; viewable?: boolean; me?: Raw | null; resolves?: boolean }): Raw {
  const me = options.me === undefined ? SELF : options.me;
  const granted = options.granted ?? [];
  const guild: Raw = {
    id: 'g1',
    members: { me, cache: new Map() },
    roles: { everyone: EVERYONE, cache: new Map() },
  };
  return {
    id: 'c1',
    name: 'general',
    topic: null,
    parent: null,
    parentId: null,
    type: ChannelType.GuildText,
    guild,
    guildId: 'g1',
    viewable: options.viewable ?? true,
    lastMessageId: null,
    isThread: () => false,
    isTextBased: () => true,
    isVoiceBased: () => false,
    isDMBased: () => false,
    permissionsFor: (who: unknown) => {
      if (who === EVERYONE) return { has: () => true };
      if (options.resolves === false) return null;
      return who === me ? { has: (flag: bigint) => granted.includes(flag) } : null;
    },
    messages: { cache: new Map(), fetch: () => Promise.resolve(new Map()) },
  };
}

function directChannel(): Raw {
  return {
    id: 'c1',
    name: null,
    topic: null,
    parent: null,
    parentId: null,
    type: ChannelType.DM,
    guild: null,
    guildId: null,
    recipientId: 'u1',
    viewable: true,
    lastMessageId: null,
    isThread: () => false,
    isTextBased: () => true,
    isVoiceBased: () => false,
    isDMBased: () => true,
    permissionsFor: () => {
      throw new Error('a private chat has no member permissions');
    },
    messages: { cache: new Map(), fetch: () => Promise.resolve(new Map()) },
  };
}

type Expected = { read: boolean; send: boolean; attach: boolean; react: boolean };
const {
  ReadMessageHistory: HISTORY,
  SendMessages: SEND,
  AttachFiles: FILES,
  AddReactions: REACT,
} = PermissionFlagsBits;

const ROWS: ReadonlyArray<{ name: string; channel: Raw; expected: Expected }> = [
  {
    name: 'a channel without a guild',
    channel: directChannel(),
    expected: { read: true, send: true, attach: true, react: true },
  },
  {
    name: 'an unviewable channel with every flag',
    channel: guildChannel({ granted: [HISTORY, SEND, FILES, REACT], viewable: false }),
    expected: { read: false, send: false, attach: false, react: false },
  },
  {
    name: 'a guild without a member me',
    channel: guildChannel({ granted: [HISTORY, SEND, FILES, REACT], me: null }),
    expected: { read: false, send: false, attach: false, react: false },
  },
  {
    name: 'permissions that do not resolve',
    channel: guildChannel({ granted: [HISTORY, SEND, FILES, REACT], resolves: false }),
    expected: { read: false, send: false, attach: false, react: false },
  },
  {
    name: 'no flag at all',
    channel: guildChannel({ granted: [] }),
    expected: { read: false, send: false, attach: false, react: false },
  },
  {
    name: 'Read Message History alone',
    channel: guildChannel({ granted: [HISTORY] }),
    expected: { read: true, send: false, attach: false, react: false },
  },
  {
    name: 'Send Messages alone',
    channel: guildChannel({ granted: [SEND] }),
    expected: { read: false, send: true, attach: false, react: false },
  },
  {
    name: 'Attach Files alone',
    channel: guildChannel({ granted: [FILES] }),
    expected: { read: false, send: false, attach: true, react: false },
  },
  {
    name: 'Add Reactions alone, which needs history as well',
    channel: guildChannel({ granted: [REACT] }),
    expected: { read: false, send: false, attach: false, react: false },
  },
  {
    name: 'Add Reactions with Read Message History',
    channel: guildChannel({ granted: [HISTORY, REACT] }),
    expected: { read: true, send: false, attach: false, react: true },
  },
  {
    name: 'every flag',
    channel: guildChannel({ granted: [HISTORY, SEND, FILES, REACT] }),
    expected: { read: true, send: true, attach: true, react: true },
  },
];

function adapterOver(channel: Raw) {
  const client = {
    user: { id: 'self-id' },
    channels: { cache: new Map([['c1', channel]]), fetch: () => Promise.resolve(null) },
    guilds: { cache: new Map<string, unknown>() },
  };
  return createDiscordAdapter({ client, config: () => ({}) });
}

for (const row of ROWS) {
  test(`reports the permissions of ${row.name} as the old checks do`, async () => {
    const result = await adapterOver(row.channel).conversationInfo({ iface: 'discord', conversationId: 'c1' });
    if (result.status !== 'ok') throw new Error(`conversationInfo answered ${result.status}`);
    const old = {
      read: canRead(row.channel),
      send: canSend(row.channel),
      attach: canAttach(row.channel),
      react: canReact(row.channel),
    };
    assert.deepEqual(result.conversation.permissions, old);
    assert.deepEqual(result.conversation.permissions, row.expected);
  });
}

test('fails a channel the client does not know instead of reporting permissions', async () => {
  const result = await adapterOver(directChannel()).conversationInfo({ iface: 'discord', conversationId: 'c404' });
  assert.equal(result.status, 'failed');
});
