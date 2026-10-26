// What the core reads from an interface's `legacy` (`RunningInterface.legacy`, src/protocol/host.ts): the platform
// objects and reads the tools and the memory jobs still take, one named field per seam. The core needs no type from
// `interfaces/`, so a platform object is `unknown` here and the core hands it on untouched. Each field names its
// reader and the item of stage 3 of the core extraction plan that removes it; the type goes with the last field. The
// Discord session builds this shape (interfaces/discord/session.ts#DiscordLegacy). An interface may have none of it
// (the fake), and the core then runs without the readers it feeds.

/** The part of the platform client the tools read: the persona's tag and the served guild with its channels. */
export type PlatformClient = {
  user: { tag: string } | null;
  guilds: { cache: { get(guildId: string): { channels: { cache: { get(channelId: string): unknown } } } | undefined } };
  channels: { cache: { get(channelId: string): unknown }; fetch(channelId: string): Promise<unknown> };
};

export type InterfaceLegacy = {
  /** The platform client. Read by the admin, the operations, the memory backfills and the recall runner's bridge. Stage 3, PR 2b (the tools' reads). */
  client: PlatformClient;
  /** The functions the core asks the platform by name, passed to the recall runner, the operations and the memory backfills as `discord`. Stage 3, PR 2b. */
  capabilities: unknown;
  /** One member by REST. Read by the avatar queue. Stage 3, PR 2b. */
  resolveMember(guildId: string, userId: string): Promise<unknown>;
  /** What the platform says of a channel, its newest messages, and a message as an event. Read by the offline catch-up. Stage 3, PR 2b. */
  catchUp: {
    channelInfo(channelId: string): { available: boolean; latestAt: number | null };
    fetchRecent(channelId: string, limit: number): Promise<Array<object>>;
    eventOf(message: object): object;
  };
  /** The persona's last messages of a channel. Read by the journal's reconciliation. Stage 3, PR 2b. */
  fetchOwnMessages(
    channelId: string,
    count: number
  ): Promise<Array<{ id: unknown; content: unknown; replyToId: string | null; createdAt: unknown }>>;
  /** The served guild's custom emoji. Read by the turn runner. Stage 3, PR 2b. */
  emoji: unknown;
  /** The slash commands: the interface builds the interaction handler over the core's admin and registers the tree. Stage 3, the tools. */
  serveCommands(admin: unknown): { register(): Promise<unknown> };
};
