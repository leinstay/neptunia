// Operations: `/nep media kind:emoji|gifs|pictures action:status|rescan|recache`: the custom emoji ranking and the GIF library, one operation per action with `kind`;
// `kind:pictures` only with `recache` (the media recache of src/memory/gif-recache.js#startMedia, `days` optional).
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import {
  rankEmojiUsage,
  rankGifs,
  gifCaptionCounts,
  gifFormatCounts,
  RECACHE_DAYS,
  gifPostsToday,
  gifWatchesToday,
} from '../../memory/index.js';
import {
  NONE,
  todayUtc,
  backfillText,
  EMOJI_RESCAN_SKIPS,
  GIFS_RESCAN_SKIPS,
  GIFS_RECACHE_SKIPS,
  PICTURES_RECACHE_SKIPS,
} from './shared.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import type { Obj, OpContext, Untyped } from '../types.ts';

/** The handler of `args.kind` among `byKindHandlers`, or an `invalid` error naming the kinds. */
function byKind<TRun>(args: Obj, byKindHandlers: Record<string, TRun>): TRun {
  const kind = typeof args.kind === 'string' ? args.kind : '';
  const handler = byKindHandlers[kind];
  if (!Object.hasOwn(byKindHandlers, kind) || handler === undefined)
    throw invalid(`kind must be one of: ${Object.keys(byKindHandlers).join(', ')}`);
  return handler;
}

const handlers = perEnv((env) => {
  const {
    hot,
    store,
    emojiBackfill,
    gifBackfill,
    gifRecache,
    skipText,
    assertNotPaused,
    freshenIfPaused,
    requireGuildId,
  } = env;

  /** `/nep emoji status`: how many emoji the ranking holds, the top 10 (rank order,
   * `context.customEmoji.halfLifeDays`) with their counts, and the history backfill stamp. */
  function cmdEmojiStatus(_args: Obj, context: OpContext): string {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const guild = store.getGuild(guildId);
    const ranked = rankEmojiUsage(guild.emojiUsage, hot.config?.context?.customEmoji?.halfLifeDays ?? 30);
    const running = emojiBackfill?.isRunning?.() ? ' (running now)' : '';
    return [
      `ranking: ${ranked.length} emoji`,
      ranked.length > 0 ? 'top 10:' : `top 10: ${NONE}`,
      ...ranked.slice(0, 10).map((entry) => `  :${entry.name}: x${entry.count}`),
      `backfill: ${backfillText(guild.emojiBackfill)}${running}`,
    ].join('\n');
  }

  /** `/nep emoji rescan`: clears `emojiUsage` and recounts it from channel history (the backfill
   * with `force`), awaited to the end. Writes under data/, so refused while paused. */
  async function cmdEmojiRescan(_args: Obj, context: OpContext): Promise<string> {
    if (!emojiBackfill) return 'the emoji backfill is not available';
    assertNotPaused();
    const guildId = requireGuildId(context);

    const result = await emojiBackfill.run(guildId, { force: true });
    if (!result.ok) return skipText(EMOJI_RESCAN_SKIPS, result.reason, `not done (${result.reason})`);
    return `Emoji rescan done: ${result.channels} channels, ${result.messages} messages read, ${result.emoji} emoji uses counted.`;
  }

  /** `/nep gifs status`: how many GIFs the library holds, the top 10 (rank order,
   * `gifs.halfLifeDays`) as `g<n> xCOUNT — caption or name`, the history backfill stamp, how
   * many GIFs the persona posted today (UTC) against `gifs.maxPerDay`
   * (src/memory/gif-watch.js#gifPostsToday), how many GIFs it watched
   * today against `media.gif.maxPerDay` (src/memory/gif-watch.js), and -- last, unless the
   * library is empty and no recache runs -- how the library's captions stand (watched /
   * one-frame / failed watch / none, see src/memory/gif-recache.js#gifCaptionCounts) with a
   * note while a recache runs, then the move to three-field captions (watched with fields /
   * watched in the old format, still to re-describe / unwatched, gifFormatCounts). Counts only. */
  function cmdGifsStatus(_args: Obj, context: OpContext): string {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const library = store.getGifs(guildId);
    const ranked = rankGifs(library, hot.config?.gifs?.halfLifeDays ?? 30) as Array<Untyped>;
    const cache = store.getMediaCache(guildId);
    const captionOf = (entry: Untyped): string => {
      const cached = (cache as Record<string, { miss?: boolean; text?: unknown } | undefined> | null)?.[entry.itemId];
      return cached && !cached.miss && typeof cached.text === 'string' ? cached.text.trim() : '';
    };
    const running = gifBackfill?.isRunning?.() ? ' (running now)' : '';
    const data = store.state.data;
    const today = todayUtc();
    const posts = gifPostsToday(data, hot.config, today);
    const watches = gifWatchesToday(data, hot.config, today);
    const captions = gifCaptionCounts(library, cache);
    const format = gifFormatCounts(library, cache);
    const recaching = gifRecache?.isRunning?.() ? ' (recache running now)' : '';
    return [
      `library: ${ranked.length} gifs`,
      ranked.length > 0 ? 'top 10:' : `top 10: ${NONE}`,
      ...ranked
        .slice(0, 10)
        .map((entry) => `  ${entry.id} x${entry.count} — ${captionOf(entry) || entry.name || entry.site || entry.url}`),
      `backfill: ${backfillText(library.backfill)}${running}`,
      `posted today: ${posts.used}/${posts.cap}`,
      `watched today: ${watches.used}/${watches.cap}`,
      // Nothing to count in an empty library, unless a recache is running.
      ...(ranked.length > 0 || recaching
        ? [
            `captions: ${captions.watched} watched, ${captions['one-frame']} one-frame, ${captions.failed} failed, ${captions.none} none${recaching}`,
            `caption format: ${format.fields} watched with fields, ${format.oldFormat} watched in the old format (to re-describe), ${format.unwatched} unwatched`,
          ]
        : []),
    ].join('\n');
  }

  /** `/nep gifs rescan`: resets the library's use counts (every entry and handle is kept) and
   * recounts them from channel history, then captions the top ones (the backfill with `force`),
   * awaited to the end. Writes under data/, so refused while paused. */
  async function cmdGifsRescan(_args: Obj, context: OpContext): Promise<string> {
    if (!gifBackfill) return 'the GIF backfill is not available';
    assertNotPaused();
    const guildId = requireGuildId(context);

    const result = await gifBackfill.run(guildId, { force: true });
    if (!result.ok) return skipText(GIFS_RESCAN_SKIPS, result.reason, `not done (${result.reason})`);
    return `GIF rescan done: ${result.channels} channels, ${result.messages} messages read, ${result.gifs} GIF uses counted, ${result.described} described.`;
  }

  /** `/nep gifs recache`: drops the one-frame GIF captions outside the library at once, then
   * re-describes up to `gifs.recachePerRun` library GIFs by watching them, in the background
   * (src/memory/gif-recache.js). Replies at once. Writes under data/, so refused while paused. */
  function cmdGifsRecache(_args: Obj, context: OpContext): string {
    if (!gifRecache) return 'the GIF recache is not available';
    assertNotPaused();
    const guildId = requireGuildId(context);

    const result = gifRecache.start(guildId);
    if (!result.ok) {
      if (result.reason === 'running')
        return 'A GIF recache is already running: media.status with kind gifs shows how far it is.';
      return skipText(GIFS_RECACHE_SKIPS, result.reason, `not started (${result.reason})`);
    }
    return [
      `GIF recache started: ${result.queued} library GIFs to watch, ${result.dropped} one-frame captions dropped from the media cache.`,
      'media.status with kind gifs shows how far it is.',
    ].join('\n');
  }

  /** `/nep media kind:pictures action:recache days:<n>`: re-describes, in the background, the
   * cached picture descriptions (GIFs, stickers and emoji included) last used within the last
   * `days` (default 7, 1..60) that an older model wrote (src/memory/gif-recache.js#startMedia).
   * Replies at once with how many were picked. Writes under data/, so refused while paused. */
  function cmdPicturesRecache(args: Obj, context: OpContext): string {
    if (typeof gifRecache?.startMedia !== 'function') return PICTURES_RECACHE_SKIPS.unavailable;
    const days = args.days ?? RECACHE_DAYS.default;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < RECACHE_DAYS.min || days > RECACHE_DAYS.max) {
      throw invalid(`days must be a whole number from ${RECACHE_DAYS.min} to ${RECACHE_DAYS.max}`);
    }
    assertNotPaused();
    const guildId = requireGuildId(context);

    const result = gifRecache.startMedia(guildId, { days });
    if (!result.ok) {
      if (result.reason === 'running') return 'A recache is already running: wait for it to finish.';
      return skipText(PICTURES_RECACHE_SKIPS, result.reason, `not started (${result.reason})`);
    }
    return [
      `Media recache started: ${result.picked} cached descriptions used in the last ${result.days} days and written by an older model are queued.`,
      'They are described again one at a time in the background; a failure keeps the old description.',
    ].join('\n');
  }

  return { cmdEmojiStatus, cmdEmojiRescan, cmdGifsStatus, cmdGifsRescan, cmdGifsRecache, cmdPicturesRecache };
});

defineOp({
  name: 'media.status',
  rights: { kind: 'read' },
  run: (args, ctx) =>
    byKind(args, { emoji: handlers(ctx.env).cmdEmojiStatus, gifs: handlers(ctx.env).cmdGifsStatus })(args, ctx),
});
defineOp({
  name: 'media.rescan',
  rights: { kind: 'write' },
  run: (args, ctx) =>
    byKind(args, { emoji: handlers(ctx.env).cmdEmojiRescan, gifs: handlers(ctx.env).cmdGifsRescan })(args, ctx),
});
defineOp({
  name: 'media.recache',
  rights: { kind: 'write' },
  run: (args, ctx) =>
    byKind(args, { gifs: handlers(ctx.env).cmdGifsRecache, pictures: handlers(ctx.env).cmdPicturesRecache })(args, ctx),
});
