// What the core reads from an interface's `legacy` (`RunningInterface.legacy`, src/protocol/host.ts): the platform
// objects and reads its subsystems still take, one named field per seam. The core needs no type from `interfaces/`,
// so a platform object is `unknown` here and the core hands it on untouched. Each field names its reader and the
// item of stage 3 of the core extraction plan that removes it; the type goes with the last field. The Discord
// session builds this shape (interfaces/discord/session.ts#DiscordLegacy), and so does the fixture behind the fake
// interface (tests/fixtures/fake-legacy.ts).

/** The part of the platform client the core itself reads: the persona's tag and the served guild with its channels. */
export type PlatformClient = {
  user: { tag: string } | null;
  guilds: { cache: { get(guildId: string): { channels: { cache: { get(channelId: string): unknown } } } | undefined } };
};

export type InterfaceLegacy = {
  /** The platform client. The core reads only the shape above and hands the rest to the turn runner, the memory jobs, the admin, the spontaneous and diary ticks. Stage 3, the inner life and the diary and the conversation reads. */
  client: PlatformClient;
  /** The functions the core asks the platform by name, passed to every module as `discord`. Stage 3, the conversation reads. */
  capabilities: unknown;
  /** The platform message behind a message event, by its id. Read by the message pipeline. Stage 3, the conversation reads. */
  rawOf(event: { id: string }): { message: unknown; previous: unknown } | null;
  /** One member by REST. Read by the avatar queue. Stage 3, the conversation reads. */
  resolveMember(guildId: string, userId: string): Promise<unknown>;
  /** A member's private conversation, when the platform knows it. Read for the memory session failure fact. Stage 3, the inner life and the diary. */
  dmConversationOf(userId: string): string | null;
  /** What the platform says of a channel, its newest messages, and a message as an event (`eventOf` keeps the message handles for `rawOf`). Read by the offline catch-up. Stage 3, the conversation reads. */
  catchUp: {
    channelInfo(channelId: string): { available: boolean; latestAt: number | null };
    fetchRecent(channelId: string, limit: number): Promise<Array<object>>;
    eventOf(message: object): object;
  };
  /** The persona's last messages of a channel. Read by the journal's reconciliation. Stage 3, the conversation reads. */
  fetchOwnMessages(
    channelId: string,
    count: number
  ): Promise<Array<{ id: unknown; content: unknown; replyToId: string | null; createdAt: unknown }>>;
  /** Who reacted to her messages. Read by the turn's history fetch. Stage 3, the conversation reads. */
  reactors: unknown;
  /** One `reaction.changed` event into the reactor store. Read by the door's reaction handler. Stage 3, the conversation reads. */
  applyReaction(event: unknown): void;
  /** The served guild's custom emoji. Read by the turn runner. Stage 3, the conversation reads. */
  emoji: unknown;
  /** The slash commands: the interface builds the interaction handler over the core's admin and registers the tree. Stage 3, the tools. */
  serveCommands(admin: unknown): { register(): Promise<unknown> };
};
