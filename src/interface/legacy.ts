// What the core reads from an interface's `legacy` (`RunningInterface.legacy`, src/protocol/host.ts): the slash
// command handler, the one seam the core still takes from a platform package. The Discord session builds this shape
// (interfaces/discord/session.ts#DiscordLegacy). An interface may have none of it (the fake), and the core then
// serves no commands.

export type InterfaceLegacy = {
  /** The slash commands: the interface builds the interaction handler over the core's admin and registers the tree. Stage 3, the tools. */
  serveCommands(admin: unknown): { register(): Promise<unknown> };
};
