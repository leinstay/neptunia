// The GIF library history backfill: members' GIFs are recorded as they arrive
// (src/memory/update.ts), so on a server with a long history the media pick
// would find nothing until enough GIFs are posted again. This reads the
// last `BACKFILL_MESSAGES` messages of every readable channel over the
// interface's history reads -- no LLM for the counting, no token budget -- and counts them
// into the library at once (src/memory/gifs.ts), starting from counts reset to
// 0 (entries and handles kept, so a GIF keeps its handle across a recount),
// then stamps `{ at, channels, messages }` for this place so it never
// counts the same history twice. The top `BACKFILL_DESCRIBE` GIFs without
// a cached caption are then sent to the media describer (real requests,
// counted against the daily cap), so the list the persona picks from says
// what each GIF shows. Runs once at startup (`startIfNeeded`) and again only
// on the owner's `/nep gifs rescan` (`run` with `force`).

import { collectPictures } from '../media/classify.ts';
import { readMemberHistory } from './emoji-backfill.ts';
import { GIF_HALF_LIFE_DAYS, gifOpts, rankGifs } from './gifs.ts';
import { log as defaultLog } from '../log.ts';
import type { Reads } from '../interface/reads.ts';
import type { StoreView } from './store.ts';
import type { Log, StoredRecord } from './types.ts';
import type { Describer, MediaItem } from './describe.ts';
import type { GifKeeper } from './gif-keeper.ts';

/** How many messages one `store.recordGifs` call takes. */
const CHUNK = 500;

// Production values, config cut of 2026-10-31.
/** The messages read per channel. */
const BACKFILL_MESSAGES = 500;
/** The GIFs without a caption sent to the describer after a count. */
const BACKFILL_DESCRIBE = 20;

function buildGifBackfill({
  store,
  reads,
  iface,
  describer = null,
  keeper = null,
  log = defaultLog,
}: {
  store: StoreView;
  reads: Reads;
  iface: () => string;
  describer?: Pick<Describer, 'describeMany'> | null;
  keeper?: Pick<GifKeeper, 'keepPictures'> | null;
  log?: Log;
}) {
  let running = false;

  /** Whether the bot is paused (`/nep pause`), read at each step. */
  function isPaused() {
    const stateData = store.state?.data;
    return Boolean(stateData?.paused);
  }

  function skipped(reason: string): { ok: false; reason: string } {
    log.info('gif-backfill: skipped', { reason });
    return { ok: false, reason };
  }

  /**
   * Describe the top `limit` library entries (rank order) that have no
   * cached caption: one describer item per entry -- the GIF's picture item
   * read this run (src/media/classify.ts#collectPictures: an attachment's
   * file, an embed's thumbnail and its animation, so the describer can watch
   * it), under the entry's `itemId`; an entry without one is skipped.
   * Returns how many got a caption.
   */
  async function describeTop(placeId: string, pictures: Map<string, MediaItem>, limit: number) {
    if (!describer || typeof describer.describeMany !== 'function' || limit <= 0) return 0;
    const ranked = rankGifs(store.getGifs(), GIF_HALF_LIFE_DAYS);
    const cache = store.mediaEntries(
      placeId,
      ranked.map((entry) => entry.itemId)
    );
    const items: Array<MediaItem> = [];
    for (const entry of ranked) {
      if (items.length >= limit) break;
      const cached = cache?.[entry.itemId];
      if (cached && !cached.miss && typeof cached.text === 'string' && cached.text.trim()) continue;
      const picture = pictures.get(entry.itemId);
      if (!picture) continue;
      items.push({ ...picture, itemId: entry.itemId, kind: 'gif', name: entry.name ?? '' });
    }
    if (items.length === 0) return 0;
    // One at a time, as a background job should: a GIF watch converts with ffmpeg.
    const { descriptions } = await describer.describeMany(placeId, items, { concurrency: 1 });
    return descriptions.size;
  }

  /**
   * Read the history and recount the library from it. Every run that goes
   * ahead RESETS every entry's count to 0 and recounts from the history
   * window alone: the window already holds the GIFs recorded on arrival
   * since the feature went live, so adding on top would count them twice.
   * Without `force` that happens only on the first run -- it is a no-op once
   * `backfill.at` is set (the startup run). With `force` it ignores the
   * stamp: the owner's explicit `/nep gifs rescan`. Entries survive the
   * reset, so a GIF seen again keeps its handle; one no longer in the window
   * stays at count 0, ranked below every counted one, until `storeMax`
   * evicts it (src/memory/gifs.ts#rankGifs). Handles are never reused.
   * Channels are read one after another (readMemberHistory). Messages of bots and of the
   * persona are skipped. Resetting, counting and stamping happen together
   * after every channel is read; the describing comes after, and only while
   * not paused. Skips (never throws) when paused, when already stamped (no `force`), while another run is in flight, or
   * when the interface lists no readable chat of the root; an unexpected error is thrown.
   */
  async function run(
    placeId: string,
    { force = false }: { force?: boolean } = {}
  ): Promise<
    { ok: true; channels: number; messages: number; gifs: number; described: number } | { ok: false; reason: string }
  > {
    if (running) return skipped('running');
    if (isPaused()) return skipped('paused');
    const stamp: StoredRecord | null = store.getGifs().backfills[placeId] ?? null;
    if (!force && stamp?.at) return skipped('done');

    running = true;
    try {
      const history = await readMemberHistory(reads, placeId, BACKFILL_MESSAGES, {
        iface: iface(),
        log,
        prefix: 'gif-backfill',
      });
      if (history === null) return skipped('no-place');
      const { channels, messages: collected } = history;

      // From here on nothing awaits until the stamp: no GIF can be recorded in between.
      if (isPaused()) return skipped('paused');
      const members = collected.sort((a, b) => a.ts - b.ts);
      const opts = gifOpts();

      // Always from zero counts: the window already holds what was recorded on arrival. Each message counts on the
      // place it was in, so those are the counters the recount starts over.
      for (const place of new Set(members.map((member) => String(member.placeId)))) store.resetGifCounts(place);
      let gifs = 0;
      for (let i = 0; i < members.length; i += CHUNK) {
        gifs += store.recordGifs(placeId, members.slice(i, i + CHUNK), opts);
      }
      store.setGifBackfill(placeId, { at: new Date().toISOString(), channels, messages: members.length });
      store.flush();

      // The picture item to describe per GIF: an attachment's file, an embed's thumbnail and animation.
      const pictures = new Map<string, MediaItem>();
      for (const message of members) {
        const found: Array<MediaItem> = collectPictures(message);
        for (const picture of found) {
          if (picture.kind === 'gif' && picture.url && !pictures.has(picture.itemId))
            pictures.set(picture.itemId, picture);
        }
      }
      const described = isPaused() ? 0 : await describeTop(placeId, pictures, BACKFILL_DESCRIBE);
      if (described > 0) store.flush();
      // Their captions and files go on the entries in the background: the owner's run does not wait for the downloads.
      void keeper?.keepPictures(placeId, [...pictures.values()]);

      const counts = { channels, messages: members.length, gifs, described };
      log.info('gif-backfill: done', counts);
      return { ok: true, ...counts };
    } finally {
      running = false;
    }
  }

  /**
   * The startup run: once, when `features.gifs` is on (a missing key counts
   * as on) and the library has no `backfill` stamp yet. Meant to be called
   * without awaiting; resolves either way, errors are logged, never thrown.
   */
  async function startIfNeeded(placeId: string): Promise<void> {
    try {
      await run(placeId);
    } catch (err) {
      log.error('gif-backfill: failed', { error: err });
    }
  }

  /** Whether a backfill is reading history (or describing) right now. */
  function isRunning() {
    return running;
  }

  return { run, startIfNeeded, isRunning };
}

export type GifBackfill = ReturnType<typeof buildGifBackfill>;

/**
 * The GIF history backfill for the served place.
 * @param deps.store      src/memory/store.ts.
 * @param deps.reads  The core's reads of the interface (src/memory/emoji-backfill.ts#readMemberHistory's).
 * @param deps.iface  The interface's name, read when a run starts.
 * @param [deps.describer]  From createDescriber() (src/memory/describe.ts): `describeMany`.
 *   Absent -> nothing is described.
 * @param [deps.log]      src/log.js-shaped logger.
 */
export function createGifBackfill(deps: Parameters<typeof buildGifBackfill>[0]): GifBackfill {
  return buildGifBackfill(deps);
}
