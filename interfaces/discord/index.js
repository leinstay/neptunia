// @neptunia/interface-discord: everything of the engine that speaks discord.js. The outbound
// adapter of the interface port (port.js), message normalization and the inbound protocol events
// with the history and permission reads (collect.js), searching other channels
// (search.js), the audience rule of a pull for the recall runner (pull-fetch.js), the conversation reads the core's
// adapter answers (reads.ts), the live voice and presence
// event builders (around.js), the served guild (guild.js), member
// cache warming (audience-warm.js) and the slash commands (commands.js), plus the factory the
// composition root builds the interface with (createDiscordInterface). The core reaches it
// by path (src/index.js); what it still imports from the core is by relative path
// (`../../src/...`) until the workspaces are declared and later stages cut those imports.

export * from './port.js';
export * from './collect.js';
export * from './media.js';
export * from './pull-fetch.js';
export * from './search.js';
export * from './around.js';
export * from './guild.js';
export * from './audience-warm.js';
export * from './commands.js';
export * from './gateway.js';

import { createDiscordAdapter } from './port.js';
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
} from './collect.js';
import { audienceAllows, checkPull } from './pull-fetch.js';
import { fetchAfter, fetchAround, fetchBefore, searchMembers, searchMessages } from './search.js';

/**
 * The Discord interface over one discord.js client: the outbound adapter of the interface port
 * and the capabilities the core asks the adapter for, by name. The functions are this package's
 * own, unchanged (they still take discord.js objects); the core's behaviors, memory jobs and
 * operations receive them through this object, which the composition root (src/index.js) builds
 * once and injects, instead of importing them (stage 4b-2).
 * @param {{ client: object, lookupChannel?: ((id: string) => object|null)|null, operations?: Iterable<string>|null,
 *   limits?: object, config?: () => unknown }} options
 *   `client` the logged-in discord.js client; the other options go to createDiscordAdapter as
 *   they are (port.js).
 * @returns {{ port: import('../../src/interface/port.js').Port, capabilities: Readonly<object>, client: object }}
 */
export function createDiscordInterface({ client, ...adapterOptions } = {}) {
  const port = createDiscordAdapter({ client, ...adapterOptions });
  const capabilities = Object.freeze({
    // What a conversation allows and holds (collect.js).
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
    // Pulling and searching other conversations (pull-fetch.js, search.js).
    audienceAllows,
    checkPull,
    searchMessages,
    searchMembers,
    fetchAround,
    fetchAfter,
    fetchBefore,
    // A message as the protocol event, for the reader that still builds one (collect.js).
    toEvent,
  });
  return { port, capabilities, client };
}

/**
 * Starts the Discord interface for the core: the session of `session.ts` (client, login, guild, link, events).
 * Loaded on the call, so the session may import `createDiscordInterface` from this file.
 * @param {import('../../src/protocol/host.ts').InterfaceHost} host
 * @returns {Promise<import('../../src/protocol/host.ts').RunningInterface>}
 */
export async function start(host) {
  const session = await import('./session.ts');
  return session.start(host);
}
