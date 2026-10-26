// The discord.js-shaped seams the core still reads while it runs on the fake interface (src/interface/fake-interface.ts):
// the `legacy` object of the 15 seams the Discord session hands over (interfaces/discord/session.ts#DiscordLegacy),
// built over one fake guild with one channel, #general (c1), and no network. The pipeline and the turn still take
// a discord.js message, a channel and a client, so `mentionEvent` builds a member's message that names the persona
// the way the gateway delivers it, turns it into the event the real adapter builds (collect.js#toEvent), keeps the
// message under the event id for `rawOf`, and returns the event for the fake interface to emit. Nothing here
// logs in, listens or leaves the process; the stage that removes the seams removes this fixture with them.
import {
  createDiscordInterface,
  createEmojiIndex,
  createReactorStore,
  normalizeOptions,
  toEvent,
} from '../../src/interface/discord.js';

type Raw = Record<string, unknown>;
type Handles = { message: unknown; previous: unknown };

export type FakeLegacy = {
  client: Raw;
  capabilities: ReturnType<typeof createDiscordInterface>['capabilities'];
  rawOf(event: { id: string }): Handles | null;
  guildId: string;
  selfId(): string | null;
  selfName(guildId: string): string;
  memberName(guildId: string, userId: string): string | null;
  resolveMember(guildId: string, userId: string): Promise<null>;
  dmConversationOf(userId: string): string | null;
  catchUp: {
    channelInfo(channelId: string): { available: boolean; latestAt: number | null };
    fetchRecent(channelId: string, limit: number): Promise<Array<object>>;
    eventOf(message: object): object;
  };
  fetchOwnMessages(channelId: string, count: number): Promise<Array<never>>;
  reactors: ReturnType<typeof createReactorStore>;
  applyReaction(event: unknown): void;
  emoji: ReturnType<typeof createEmojiIndex>;
  serveCommands(admin: unknown): { register(): Promise<unknown> };
};

export type MemberMessage = { id: string; content: string; at: number; authorId?: string; authorName?: string };

export function createFakeLegacy(
  options: { guildId?: string; selfId?: string; selfName?: string; channelId?: string; channelName?: string } = {}
): { legacy: FakeLegacy; mentionEvent(message: MemberMessage): Raw } {
  const guildId = options.guildId ?? 'g1';
  const selfId = options.selfId ?? 'self-id';
  const selfName = options.selfName ?? 'Bot';
  const channelId = options.channelId ?? 'c1';

  const history: Array<Raw> = [];
  const held = new Map<string, Handles>();
  const guild: Raw = {
    id: guildId,
    name: 'Alpha',
    members: { me: { id: selfId, displayName: selfName }, cache: new Map<string, Raw>() },
    channels: { cache: new Map<string, Raw>() },
    emojis: { cache: new Map<string, Raw>() },
  };
  const channel: Raw = {
    id: channelId,
    name: options.channelName ?? 'general',
    guild,
    guildId,
    parent: null,
    parentId: null,
    topic: null,
    viewable: true,
    lastMessageId: null,
    isTextBased: () => true,
    isThread: () => false,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    sendTyping: () => Promise.resolve(),
    send: () => Promise.resolve({ id: 'unused' }),
    messages: {
      cache: new Map<string, Raw>(),
      fetch: (arg: unknown): Promise<unknown> => {
        if (arg !== null && typeof arg === 'object' && 'limit' in arg) {
          return Promise.resolve(new Map(history.map((message) => [String(message.id), message])));
        }
        return Promise.resolve(history.find((message) => message.id === arg) ?? null);
      },
    },
  };
  (guild.channels as { cache: Map<string, Raw> }).cache.set(channelId, channel);

  const client: Raw = {
    user: { id: selfId, username: selfName, tag: `${selfName}#0001` },
    guilds: { cache: new Map<string, Raw>([[guildId, guild]]) },
    channels: {
      cache: new Map<string, Raw>([[channelId, channel]]),
      fetch: (id: string): Promise<Raw | null> => Promise.resolve(id === channelId ? channel : null),
    },
    users: { cache: new Map<string, Raw>() },
  };

  const reactors = createReactorStore();
  const normalize = (): ReturnType<typeof normalizeOptions> => normalizeOptions({});

  const legacy: FakeLegacy = {
    client,
    capabilities: createDiscordInterface({ client }).capabilities,
    rawOf: (event) => held.get(event.id) ?? null,
    guildId,
    selfId: () => selfId,
    selfName: () => selfName,
    memberName: () => null,
    resolveMember: () => Promise.resolve(null),
    dmConversationOf: () => null,
    catchUp: {
      channelInfo: () => ({ available: false, latestAt: null }),
      fetchRecent: () => Promise.resolve([]),
      eventOf(message: object): object {
        const event = toEvent(message, selfId, normalize());
        held.set(event.id, { message: event.raw, previous: event.rawPrevious ?? null });
        return event;
      },
    },
    fetchOwnMessages: () => Promise.resolve([]),
    reactors,
    applyReaction: () => {},
    emoji: createEmojiIndex(client as { guilds: { cache: Map<string, never> } }, () => guildId),
    serveCommands: () => ({ register: () => Promise.resolve(undefined) }),
  };

  function mentionEvent(message: MemberMessage): Raw {
    const authorId = message.authorId ?? 'u1';
    const authorName = message.authorName ?? 'Eleni';
    const author = { id: authorId, bot: false, globalName: authorName, username: authorName };
    const raw: Raw = {
      id: message.id,
      system: false,
      webhookId: null,
      author,
      member: { id: authorId, displayName: authorName, user: author, avatar: null },
      guild,
      guildId,
      channel,
      channelId,
      content: message.content,
      cleanContent: message.content,
      createdTimestamp: message.at,
      editedTimestamp: null,
      reference: null,
      mentions: { users: new Map([[selfId, { id: selfId }]]) },
      attachments: new Map(),
      stickers: new Map(),
      embeds: [],
      messageSnapshots: new Map(),
      flags: { has: () => false },
    };
    history.push(raw);
    const built = toEvent(raw, selfId, normalize());
    // The event as the fake interface speaks it: its own namespace in the id, the message behind it kept for `rawOf`.
    const event: Raw = { ...built, iface: 'fake', id: `fake:message:${message.id}` };
    held.set(String(event.id), { message: raw, previous: null });
    return event;
  }

  return { legacy, mentionEvent };
}
