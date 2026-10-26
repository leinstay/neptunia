// What the replay tool still reads off the platform's own guild and channel objects: it runs over a discord.js client
// (REST only) and hands the engine's skills what a live turn gets from the interface instead. Every function takes
// `unknown` and narrows, so the objects of any platform fixture pass.

import type { Reads } from '../../src/interface/reads.ts';
import { createReads } from '../../src/interface/reads.ts';
import { createDiscordAdapter } from '../../interfaces/discord/index.js';

type Obj = Record<string, unknown>;

const obj = (value: unknown): Obj => (value !== null && typeof value === 'object' ? (value as Obj) : {});

/** The values of a `cache` Map-like, or none. */
function valuesOf(cache: unknown): Array<unknown> {
  const values = obj(cache).values;
  return typeof values === 'function' ? [...(values.call(cache) as Iterable<unknown>)] : [];
}

/**
 * The group ids `authorId` holds in the guild of `channel` (none when the member is not cached): what a replay over the
 * platform's own objects reads where a live turn asks the interface for the member.
 */
export function roleIdsOf(channel: unknown, authorId: unknown): Array<string> {
  const members = obj(obj(obj(channel).guild).members).cache;
  const get = obj(members).get;
  const member: unknown = typeof get === 'function' ? get.call(members, String(authorId)) : undefined;
  const roles = obj(obj(member).roles).cache;
  const keys = obj(roles).keys;
  return typeof keys === 'function' ? [...(keys.call(roles) as Iterable<unknown>)].map(String) : [];
}

type Requester = { id: string; roleIds: Array<string> } | null;

/**
 * src/behavior/turn.js#requesterOf over a discord.js channel: the roles of the requester are read off its guild.
 * `requesterOf` is the engine's function, taken as given.
 */
export function requesterOfChannel(requesterOf: unknown): (trigger: unknown, channel: unknown) => Requester {
  const requesterOfRoles = requesterOf as (trigger: object | null, roleIds: Array<string>) => Requester;
  return (trigger, channel) =>
    requesterOfRoles(
      trigger !== null && typeof trigger === 'object' ? trigger : null,
      roleIdsOf(channel, obj(trigger).authorId)
    );
}

/** The channels and the roles of the guild of a discord.js `channel` as the conversations and groups of a listing (names only). */
export function guildListing(channel: unknown): {
  conversations: Array<{ id: string; name: string }>;
  groups: Array<{ id: string; name: string }>;
} {
  const named = (cache: unknown): Array<{ id: string; name: string }> =>
    valuesOf(cache).flatMap((entry) => {
      const found = obj(entry);
      return typeof found.id === 'string' && typeof found.name === 'string' ? [{ id: found.id, name: found.name }] : [];
    });
  const held = obj(obj(channel).guild);
  return { conversations: named(obj(held.channels).cache), groups: named(obj(held.roles).cache) };
}

/** The replay's channel as the conversation info a skill is handed (the community when it has a guild). */
export function conversationOfChannel(
  channel: unknown,
  communityId: string
): { id: string; name: string | null; communityId: string | null } {
  const found = obj(channel);
  return {
    id: String(found.id),
    name: typeof found.name === 'string' ? found.name : null,
    communityId: found.guild ? communityId : null,
  };
}

type Recall = { run?: unknown; window?: unknown };

/**
 * The recall runner, which still reads the platform's channel and guild, with the channel and guild this replay holds
 * put into whatever a call names.
 */
export function onPlatformChannel<T extends Recall>(recall: T, platform: { guild: unknown; channel: unknown }): T {
  const bound = (method: unknown) =>
    typeof method === 'function'
      ? (args: Obj): unknown => (method as (args: Obj) => unknown).call(recall, { ...args, ...platform })
      : method;
  return { ...recall, run: bound(recall.run), ...('window' in recall ? { window: bound(recall.window) } : {}) };
}

const quiet = { info() {}, warn() {}, error() {} };

/**
 * The interface's reads over a discord.js client (the replay's, REST only): the history `conversation.read` asks for,
 * with the interface they belong to.
 */
export function discordReads(client: unknown, config: () => unknown): { reads: Reads; iface: string } {
  const port = createDiscordAdapter({ client: obj(client), config: config as () => object });
  return { reads: createReads(port, quiet), iface: port.iface };
}
