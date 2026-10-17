// The server's custom emoji in the persona's own output. The model writes
// `:name:` (the way it reads them in the transcript); Discord only shows a
// custom emoji as `<:name:id>` / `<a:name:id>`. The pure functions of
// src/behavior/emoji.js turn one into the other through a `lookup(name)`, and
// createEmojiIndex is the one thin view over discord.js that backs that
// lookup: it keeps no copy, the guild's emoji cache (kept current by
// discord.js) is the map.

import { matchEmojiName } from '../../src/behavior/emoji.js';

/**
 * A live name/id view over the served guild's custom emoji. Nothing is
 * copied: every call reads `client.guilds.cache.get(guildId).emojis.cache`,
 * which discord.js keeps current (the GuildExpressions intent delivers the
 * emoji updates). `guildId` may be a getter, read at use.
 * @param {{ guilds: { cache: Map<string, any> } }} client
 * @param {string|(() => (string|null))} guildId
 * @returns {{ byName: (name: string) => ({ id: string, name: string, animated: boolean }|null),
 *             list: () => { id: string, name: string, animated: boolean }[] }}
 */
export function createEmojiIndex(client, guildId) {
  function cache() {
    const id = typeof guildId === 'function' ? guildId() : guildId;
    return (id && client?.guilds?.cache?.get(id)?.emojis?.cache) || null;
  }
  return {
    byName: (name) => {
      const emojis = cache();
      return emojis ? matchEmojiName(emojis.values(), name) : null;
    },
    list: () => {
      const emojis = cache();
      if (!emojis) return [];
      return [...emojis.values()]
        .filter((e) => e?.id && e.name && e.available !== false)
        .map((e) => ({ id: e.id, name: e.name, animated: Boolean(e.animated) }));
    },
  };
}
