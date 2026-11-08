// @neptunia/interface-discord: everything of the engine that speaks discord.js. The outbound
// adapter of the interface port (port.ts), message normalization and the inbound protocol events
// with the history and permission reads (collect.ts), searching other channels
// (search.ts), the audience rule of a pull for the recall runner (pull-fetch.ts), the chat reads the core's
// adapter answers (reads.ts), the live voice and presence
// event builders (around.ts), the served guild (guild.ts), member
// cache warming (audience-warm.ts), plus the factory the
// composition root builds the interface with (createDiscordInterface). The core reaches it
// by path (src/index.ts); what it still imports from the core is by relative path
// (`../../src/...`) until the workspaces are declared and later stages cut those imports.

export * from './port.ts';
export * from './collect.ts';
export * from './media.ts';
export * from './pull-fetch.ts';
export * from './search.ts';
export * from './around.ts';
export * from './guild.ts';
export * from './audience-warm.ts';
export * from './gateway.ts';

import { createDiscordAdapter } from './port.ts';
import {
  PAGE,
  audienceOf,
  canAttach,
  canReact,
  canRead,
  canSend,
  channelDirectoryOf,
  fetchHistory,
  fetchHistoryWindow,
  fetchMessage,
  isReadableChannel,
  isWritableChannel,
  lastActivity,
  normalizeMessage,
  normalizeOptions,
  readableChannels,
  snowflakeTime,
  toEvent,
} from './collect.ts';
import { audienceAllows, checkPull } from './pull-fetch.ts';
import { fetchAfter, fetchAround, fetchBefore, searchMembers, searchMessages } from './search.ts';

import type { Port } from '../../src/protocol/index.ts';
import type { InterfaceHost, RunningInterface } from '../../src/protocol/host.ts';
/**
 * The Discord interface over one discord.js client: the outbound adapter of the interface port
 * and the capabilities the core asks the adapter for, by name. The functions are this package's
 * own, unchanged (they still take discord.js objects); the core's behaviors, memory jobs and
 * operations receive them through this object, which the composition root (src/index.ts) builds
 * once and injects, instead of importing them (stage 4b-2).
 * @param options `client` the logged-in discord.js client; the other options go to createDiscordAdapter as
 *   they are (port.ts).
 */
export function createDiscordInterface({
  client,
  ...adapterOptions
}: Parameters<typeof createDiscordAdapter>[0] = {}): {
  port: Port;
  capabilities: Readonly<object>;
  client: Parameters<typeof createDiscordAdapter>[0]['client'];
} {
  const port = createDiscordAdapter({ client, ...adapterOptions });
  const capabilities = Object.freeze({
    // What a chat allows and holds (collect.ts).
    canRead,
    canSend,
    canAttach,
    canReact,
    isReadableChannel,
    isWritableChannel,
    readableChannels,
    channelDirectoryOf,
    lastActivity,
    snowflakeTime,
    audienceOf,
    fetchHistory,
    fetchHistoryWindow,
    fetchMessage,
    normalizeMessage,
    normalizeOptions,
    PAGE,
    // Pulling and searching other chats (pull-fetch.ts, search.ts).
    audienceAllows,
    checkPull,
    searchMessages,
    searchMembers,
    fetchAround,
    fetchAfter,
    fetchBefore,
    // A message as the protocol event, for the reader that still builds one (collect.ts).
    toEvent,
  });
  return { port, capabilities, client };
}

/**
 * Starts the Discord interface for the core: the session of `session.ts` (client, login, guild, link, events).
 * Loaded on the call, so the session may import `createDiscordInterface` from this file.
 */
export async function start(host: InterfaceHost): Promise<RunningInterface> {
  const session = await import('./session.ts');
  return session.start(host);
}
