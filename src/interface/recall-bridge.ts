// The recall runner (src/behavior/recall-run.js) still reads the platform's own guild, channel and member objects.
// A turn hands it what the core knows (the community id, the conversation's info, the partner's member info), and
// this bridge resolves the objects through the platform client the interface hands over in `legacy`, so the runner
// runs unchanged. It goes with the runner's conversion to the core's reads; without a client the runner is called as
// it is and answers not configured.

type Obj = Record<string, unknown>;

type Client = {
  guilds: { cache: { get(id: string): Obj | undefined } };
  channels: { cache: { get(id: string): unknown }; fetch(id: string): Promise<unknown> };
};

/** The methods of the runner that take a conversation: each gets the platform's objects in place of the ids. */
const PLATFORM_METHODS = ['run', 'prefetch', 'window'] as const;

const obj = (value: unknown): Obj => (value !== null && typeof value === 'object' ? (value as Obj) : {});

async function platformArgs(client: Client, args: Obj): Promise<Obj> {
  const guildId = typeof args.guildId === 'string' ? args.guildId : (obj(args.guild).id as string | undefined);
  const guild = guildId === undefined ? null : (client.guilds.cache.get(guildId) ?? null);
  const info = obj(args.channel);
  const channelId = typeof info.id === 'string' ? info.id : null;
  const channel =
    channelId === null
      ? args.channel
      : (client.channels.cache.get(channelId) ??
        (await Promise.resolve(client.channels.fetch(channelId)).catch(() => null)) ??
        args.channel);
  const partnerId = typeof obj(args.partner).id === 'string' ? (obj(args.partner).id as string) : null;
  const members = obj(guild?.members);
  let partner: unknown = args.partner ?? null;
  if (partnerId !== null && guild !== null) {
    const cached = obj(members.cache).get as ((id: string) => unknown) | undefined;
    partner = cached?.call(members.cache, partnerId) ?? args.partner;
    if (typeof members.fetch === 'function' && partner === args.partner)
      partner =
        (await Promise.resolve((members.fetch as (id: string) => Promise<unknown>).call(members, partnerId)).catch(
          () => null
        )) ?? args.partner;
  }
  return { ...args, guild, channel, partner };
}

/** `recall` with its conversation methods taking the core's ids and info. */
export function bridgeRecall<T extends object>(recall: T, client: Client | undefined): T {
  if (client === undefined) return recall;
  const bridged: Record<string, unknown> = { ...(recall as Record<string, unknown>) };
  for (const name of PLATFORM_METHODS) {
    const method = bridged[name];
    if (typeof method !== 'function') continue;
    bridged[name] = async (args: Obj = {}): Promise<unknown> =>
      (method as (args: Obj) => Promise<unknown>)(await platformArgs(client, args));
  }
  return bridged as T;
}
