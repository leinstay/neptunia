// @neptunia/interface-discord: everything of the engine that speaks discord.js. The outbound
// adapter of the interface port (port.js), message normalization and the inbound protocol events
// with the history and permission reads (collect.js), pulling and searching other channels
// (pull-fetch.js, search.js), the reactor store (reactors.js), the live voice and presence
// records (around.js), the custom emoji index (emoji.js), the served guild (guild.js), member
// cache warming (audience-warm.js) and the slash commands (commands.js), plus the factory the
// composition root builds the interface with (createDiscordInterface). The core reaches it
// through src/interface/discord.js; what it still imports from the core is by relative path
// (`../../src/...`) until the workspaces are declared and later stages cut those imports.

export * from './port.js';
export * from './collect.js';
export * from './pull-fetch.js';
export * from './search.js';
export * from './reactors.js';
export * from './around.js';
export * from './emoji.js';
export * from './guild.js';
export * from './audience-warm.js';
export * from './commands.js';

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
  fetchNeighbors,
  fetchReplyParents,
  isReadableChannel,
  isWritableChannel,
  lastActivity,
  normalizeMessage,
  normalizeOptions,
  readableChannels,
  withTextPreviews,
} from './collect.js';
import { audienceAllows, captionPulled, checkPull, createPullViews, fetchPull } from './pull-fetch.js';
import { fetchAfter, fetchAround, searchMembers, searchMessages } from './search.js';
import { reactorIdsOf } from './reactors.js';

/**
 * The Discord interface over one discord.js client: the outbound adapter of the interface port
 * and the capabilities the core asks the adapter for, by name. The functions are this package's
 * own, unchanged (they still take discord.js objects); the core's behaviors receive them through
 * this object instead of importing them (stage 4b-2).
 * @param {{ client: object, lookupChannel?: ((id: string) => object|null)|null, operations?: Iterable<string>|null,
 *   limits?: object }} options
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
    audienceOf,
    fetchHistory,
    fetchHistoryWindow,
    fetchMessage,
    fetchReplyParents,
    fetchNeighbors,
    withTextPreviews,
    normalizeMessage,
    normalizeOptions,
    PAGE,
    // Pulling and searching other conversations (pull-fetch.js, search.js).
    audienceAllows,
    captionPulled,
    checkPull,
    createPullViews,
    fetchPull,
    searchMessages,
    searchMembers,
    fetchAround,
    fetchAfter,
    // Who reacted (reactors.js).
    reactorIdsOf,
  });
  return { port, capabilities, client };
}
