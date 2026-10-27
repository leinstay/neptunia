// The code-only memory of the live message path: every guild message the persona sees moves the counters of its
// author's profile and of its channel's map entry (`touchMemory`), feeds the GIF library, the custom emoji ranking
// and the names members are called by (`recordAddressing`). No model is asked here: what she remembers of a
// conversation is written by her memory session over the memory database (src/memory/db/session.js), which reads
// the observed lines from the database. `slimMessage` is the one shape a normalized message is kept in by the
// record (src/memory/record.js#toRecordLine) and by the late-embed fold of src/behavior/pipeline.js.

import { log } from '../log.js';
import { DEFAULT_ADDRESS_HALF_LIFE_DAYS, addressCandidates, countAddressUses } from './addressed.js';
import { emojiUsageOpts } from './emoji-usage.js';
import { gifOpts } from './gifs.js';
import { recordLinks } from './record.js';

/**
 * The log `error` field of a failure: the error's name only (`SyntaxError`, `TypeError`, `Error`), never its message.
 * @param {unknown} err
 * @returns {string}
 */
export function errorNameOf(err) {
  return typeof err?.name === 'string' && err.name ? err.name : 'Error';
}

/**
 * Normalized set of `config.memory.mainChannelIds`, compared as strings. Garbage config (not an array, non-string
 * entries) never throws: a non-array collapses to an empty set, every entry is coerced with String().
 * @param {unknown} mainChannelIds
 * @returns {Set<string>}
 */
export function mainChannelSet(mainChannelIds) {
  return new Set((Array.isArray(mainChannelIds) ? mainChannelIds : []).map((id) => String(id)));
}

/**
 * Count which names observed guild lines call members by (src/memory/addressed.js) and fold
 * the uses into each member's `addressedAs` (`store.recordAddressUses`, `cfg.addressHalfLifeDays`,
 * 30 when missing). The candidates are every stored profile of the guild; other bots' lines are
 * skipped, the persona's own count. A store without `listUserProfiles` / `recordAddressUses` (a
 * test fake) counts nothing.
 * @param {object} store
 * @param {string} guildId
 * @param {object[]} messages  The observed slim messages.
 * @param {object} [cfg]  `config.memory`, read at the moment of use.
 * @returns {number}  The uses recorded.
 */
export function recordAddressing(store, guildId, messages, cfg = {}) {
  if (typeof store?.listUserProfiles !== 'function' || typeof store?.recordAddressUses !== 'function') return 0;
  const lines = (Array.isArray(messages) ? messages : []).filter((m) => m && !m.bot);
  if (lines.length === 0) return 0;
  const uses = countAddressUses(lines, addressCandidates(store.listUserProfiles(guildId)));
  let recorded = 0;
  for (const [userId, list] of uses) {
    if (
      store.recordAddressUses(guildId, userId, list, {
        halfLifeDays: cfg?.addressHalfLifeDays ?? DEFAULT_ADDRESS_HALF_LIFE_DAYS,
      })
    )
      recorded += list.length;
  }
  return recorded;
}

/**
 * Record that a normalized message happened, for the counters kept on a
 * user's profile and a channel's map entry: `touchUser` (skipped for the
 * persona's own messages) and `touchChannel`, whose `topWriters` tally also
 * skips the persona's own messages and other bots. Used by `observe()`, the
 * live pipeline.
 * @param {object} store
 * @param {string} guildId
 * @param {object} normalized  A normalized message (src/protocol/events.js#Message);
 *   callers are expected to have already dropped other bots' messages.
 * @param {object} [memoryCfg]  The live `config.memory`, for the tally's settings
 *   (`channelWritersStored`, `channelWritersHalfLifeDays`); omitted -> the store's fallbacks.
 *   `diaryChannelId` (the caller adds `diary.channelId`) names the one channel where the persona's
 *   own messages count as a writer.
 */
export function touchMemory(store, guildId, normalized, memoryCfg) {
  if (!normalized.self) {
    store.touchUser(guildId, normalized.authorId, normalized.authorName, normalized.ts);
  }
  // The persona's own messages and other bots never count toward a channel's
  // top writers -- see src/memory/store.js#touchChannel.
  // The one exception is the configured diary channel (`memoryCfg.diaryChannelId`, from
  // `diary.channelId`): the persona is its writer, so the map does not show it as dead.
  const diaryChannelId = memoryCfg?.diaryChannelId || null;
  const inDiary = diaryChannelId !== null && normalized.channelId === diaryChannelId;
  const writerId = !normalized.bot && (!normalized.self || inDiary) ? normalized.authorId : null;
  store.touchChannel(
    guildId,
    normalized.channelId,
    { name: normalized.channelName, category: normalized.channelCategory, topic: normalized.channelTopic },
    normalized.ts,
    writerId,
    memoryCfg
  );
}

/**
 * The media of one normalized message part (the message itself or one
 * forwarded snapshot) as a slim message keeps it. No URL ever survives
 * into it -- but the item `id` does. A sticker keeps `id`/`name`/`format` and its `url` (a fixed picture address,
 * null for a sticker with no picture); a custom emoji keeps only `id`/`name` (its URL is rebuilt via emojiUrl).
 */
/**
 * A sticker as a slim message keeps it: `id`, `name`, `format` and the `url` of its picture (null for a sticker with none).
 * @param {{ id?: unknown, name?: unknown, format?: unknown, url?: unknown }} sticker
 */
function slimSticker(sticker) {
  return { id: sticker.id, name: sticker.name, format: sticker.format, url: sticker.url ?? null };
}

function slimMedia(part) {
  return {
    attachments: (part.attachments ?? []).map((a) => ({
      kind: a.kind,
      name: a.name,
      id: a.id,
      durationSec: a.durationSec ?? null,
    })),
    links: (part.links ?? []).map((l) => ({
      kind: l.kind,
      name: l.title || l.site || '',
      id: l.id,
      durationSec: null,
    })),
    stickers: (part.stickers ?? []).map(slimSticker),
    emojis: (part.emojis ?? []).map((e) => ({ id: e.id, name: e.name })),
  };
}

/**
 * One normalized message as the record keeps it: ids, author, content, `ts`, the
 * reply target and its media without any URL (slimMedia), the forwarded snapshots stripped
 * the same way, and `direct`; a message whose links carry a preview title or description also
 * keeps them as `linkCards` (src/memory/record.js#recordLinks: URL, title, description, site),
 * which only the record reads.
 * @param {object} normalized  A normalized message (src/protocol/events.js#Message).
 * @param {boolean} [direct]   Whether the message was addressed to the persona.
 * @returns {object}
 */
export function slimMessage(normalized, direct = false) {
  const linkCards = recordLinks(normalized.links);
  const forwarded = (normalized.forwarded ?? []).map((snapshot) => ({
    content: snapshot.content ?? '',
    ...slimMedia(snapshot),
  }));
  return {
    id: normalized.id,
    channelId: normalized.channelId,
    channelName: normalized.channelName,
    authorId: normalized.authorId,
    authorName: normalized.authorName,
    self: normalized.self,
    bot: normalized.bot,
    content: normalized.content,
    ts: normalized.ts,
    replyToId: normalized.replyToId,
    // The members the message mentions (the record's `mentions`); absent when none.
    ...(Array.isArray(normalized.mentionedUserIds) && normalized.mentionedUserIds.length > 0
      ? { mentionedUserIds: [...normalized.mentionedUserIds] }
      : {}),
    ...slimMedia(normalized),
    // The link previews the record keeps (toRecordLine's `links`); absent when none.
    ...(linkCards.length > 0 ? { linkCards } : {}),
    // A forwarded message's snapshots (`forwarded`,
    // src/protocol/events.js#Message), stripped the same way. Absent for a message
    // with no forward.
    ...(forwarded.length > 0 ? { forwardedFrom: normalized.forwardedFrom ?? null, forwarded } : {}),
    direct: Boolean(direct),
  };
}

/**
 * The live observer (src/behavior/pipeline.js calls `observe` for every guild message the persona sees, her own
 * included). A private chat's line (`private`: the partner's id) moves no public counter, feeds no GIF library and
 * counts no names. Nothing while `/nep pause` holds.
 * @param {{ hot: { config: object }, store: object }} deps
 */
export function createMemoryUpdater({ hot, store }) {
  /**
   * One observed message: the counters (`touchMemory`), the GIF library, the emoji usage and the address counts.
   * `direct` marks a message addressed to the persona. Never throws on a store that cannot be read: the count is
   * left out with a warning.
   */
  function observe(guildId, normalized, { direct = false, private: privateUserId = null } = {}) {
    // /nep pause: nothing may make the store dirty while paused.
    if (store.state.data.paused) return;
    if (normalized.bot) return;
    if (privateUserId) return;
    touchMemory(store, guildId, normalized, {
      ...hot.config.memory,
      diaryChannelId: hot.config.diary?.channelId || null,
    });
    // The GIF library (src/memory/gifs.js) is fed here: it needs the GIF's URL, which no slim message keeps.
    if (hot.config.features?.gifs !== false) {
      const gifs = store.recordGifs(guildId, [normalized], gifOpts(hot.config));
      if (gifs > 0) log.info('memory: gifs recorded', { guildId, gifs });
    }
    const slim = slimMessage(normalized, direct);
    try {
      store.recordEmojiUsage(guildId, [slim], emojiUsageOpts(hot.config));
    } catch (err) {
      log.warn('memory: emoji count left out', { guildId, reason: 'store-error', error: errorNameOf(err) });
    }
    try {
      recordAddressing(store, guildId, [slim], hot.config.memory ?? {});
    } catch (err) {
      log.warn('memory: address count left out', { guildId, reason: 'store-error', error: errorNameOf(err) });
    }
  }

  return { observe };
}
