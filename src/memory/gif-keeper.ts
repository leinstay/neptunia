// The keeper of the shared GIF library's search and files: for a GIF the library holds it has the describer describe it,
// gives the entry the description its row holds and the description's vector (the candidate search of src/behavior/media-pick.ts reads them), and
// caches the file (src/media/gif-files.ts), because an attachment's link expires and the file is the record. The memory
// updater and the edit handler call `keep` for a message that added a GIF, the history backfill for what it read, and the
// core's start calls `settle` once per served place, which fills what an entry can get without its message. One GIF at
// a time, in the background. A failure leaves the entry as it was, and the GIF's next sighting tries again. Logs carry counts.

import { cacheGifFile } from '../media/gif-files.ts';
import { collectPictures } from '../media/classify.ts';
import { captionOfCached, normalizeGifs, rankGifs } from './gifs.ts';
import { log as defaultLog } from '../log.ts';
import { DAY_MS } from '../time.ts';
import type { GifBytes } from '../media/gif-files.ts';
import type { Log, StoredRecord } from './types.ts';
import type { MediaItem } from './describe.ts';

/** The most GIFs a start's `settle` fetches or embeds, so a start with a long library spends a little of the day's rails. */
const SETTLE_PER_RUN = 50;

/** How long `settle` leaves an entry whose file failed to download before it fetches the stored URL again. */
const FILE_RETRY_MS = 7 * DAY_MS;

/** The store as the keeper reads and writes it. */
type KeeperStore = {
  state?: { data?: { paused?: unknown } };
  getGifs: () => unknown;
  getGifVectors: (model?: string | null) => ReadonlyMap<string, ArrayLike<number>>;
  mediaEntry: (placeId: string, key: string) => unknown;
  setGifDescribed: (
    key: string,
    described: { description: string; vector: ArrayLike<number> | null; model?: string | null }
  ) => void;
  setGifFile: (key: string, file: { hash: string; file: string }) => void;
  setGifFileFailed: (key: string, at: number) => void;
};

export type GifKeeper = {
  /** The GIFs of a message of `placeId` that the library counted: fire and forget, never rejects. */
  keep: (placeId: string, message: StoredRecord) => Promise<void>;
  /** The pictures a history read found: fire and forget, never rejects. */
  keepPictures: (placeId: string, pictures: ReadonlyArray<MediaItem>) => Promise<void>;
  /** What the entries can get without their messages: the descriptions the cache holds, their vectors, a file by the stored URL. */
  settle: (placeId: string) => Promise<void>;
};

export function createGifKeeper({
  store,
  dataDir,
  fetchBytes,
  embed = null,
  embedModel = () => null,
  describer = null,
  now = Date.now,
  log = defaultLog,
}: {
  store: KeeperStore;
  dataDir: string;
  fetchBytes: (url: string) => Promise<GifBytes>;
  /** The embedder of a description; null, or a failure: the search reads its words alone. */
  embed?: ((text: string) => Promise<ArrayLike<number> | null>) | null;
  /** The model `embed` answers with now, which a stored vector must match. */
  embedModel?: () => string | null;
  describer?: { describeMany: (placeId: string, items: Array<MediaItem>, options: object) => Promise<unknown> } | null;
  now?: () => number;
  log?: Log;
}): GifKeeper {
  // One after another, whoever asks: a watch converts with ffmpeg and a whole-library write is not small.
  let queue: Promise<unknown> = Promise.resolve();
  const later = (work: () => Promise<void>): Promise<void> => {
    const run = queue.then(work).catch((err: unknown) => log.warn('gif-keeper: failed', { error: err }));
    queue = run;
    return run;
  };
  const paused = () => {
    const stateData = store.state?.data;
    return Boolean(stateData?.paused);
  };

  /** The entry a native id is held under, read now: a file on another message may have moved it. */
  function entryOf(itemId: string) {
    const { entries } = normalizeGifs(store.getGifs());
    return Object.values(entries).find((entry) => entry.nativeIds.includes(itemId)) ?? null;
  }

  async function vectorOf(text: string): Promise<ArrayLike<number> | null> {
    if (!embed) return null;
    try {
      return await embed(text);
    } catch (err) {
      log.info('gif-keeper: no vector', { error: err });
      return null;
    }
  }

  /** The description the cache holds for the entry, else the entry's own, when the entry lacks it or its vector under
   *  the model in force. The cache's cap takes out rows the library still describes. */
  function descriptionDue(placeId: string, itemId: string): string | null {
    const entry = entryOf(itemId);
    if (!entry) return null;
    const description = captionOfCached(store.mediaEntry(placeId, itemId)) || entry.description || null;
    const hasVector = store.getGifVectors(embedModel()).has(entry.itemId);
    if (!description || (entry.description === description && (hasVector || !embed))) return null;
    return description;
  }

  /** The description the cache holds given to the entry with its vector, when the entry lacks either. */
  async function describeEntry(placeId: string, itemId: string): Promise<void> {
    const description = descriptionDue(placeId, itemId);
    if (description)
      store.setGifDescribed(itemId, { description, vector: await vectorOf(description), model: embedModel() });
  }

  /** The file of the entry cached from the first of `urls` that gives one; whether one did. */
  async function fileEntry(itemId: string, urls: ReadonlyArray<string | undefined>): Promise<boolean> {
    if (!entryOf(itemId) || entryOf(itemId)?.file) return true;
    for (const url of urls) {
      if (!url) continue;
      const cached = await cacheGifFile({ url, dataDir, fetchBytes });
      if (cached) {
        store.setGifFile(itemId, cached);
        return true;
      }
    }
    return false;
  }

  async function keepPicture(placeId: string, picture: MediaItem): Promise<void> {
    if (paused() || !picture.itemId) return;
    const held = captionOfCached(store.mediaEntry(placeId, picture.itemId));
    if (!held && describer) await describer.describeMany(placeId, [picture], { concurrency: 1 });
    await describeEntry(placeId, picture.itemId);
    await fileEntry(picture.itemId, [picture.animationUrl, picture.url]);
  }

  return {
    keep(placeId, message) {
      const found: Array<MediaItem> = collectPictures(message);
      const gifs = found.filter((picture) => picture.kind === 'gif');
      return later(async () => {
        for (const picture of gifs) await keepPicture(placeId, picture);
      });
    },
    keepPictures(placeId, pictures) {
      return later(async () => {
        for (const picture of pictures) await keepPicture(placeId, picture);
      });
    },
    settle(placeId) {
      return later(async () => {
        // The budget counts the entries fetched or embedded: vectors first, then files, each step by its own need.
        const worked = new Set<string>();
        const mayWork = (itemId: string) => !paused() && (worked.has(itemId) || worked.size < SETTLE_PER_RUN);
        let vectors = 0;
        let files = 0;
        for (const entry of rankGifs(store.getGifs())) {
          if (!descriptionDue(placeId, entry.itemId) || !mayWork(entry.itemId)) continue;
          worked.add(entry.itemId);
          await describeEntry(placeId, entry.itemId);
          vectors += 1;
        }
        for (const entry of rankGifs(store.getGifs())) {
          const failedAt = entry.fileFailedAt ?? 0;
          if (entry.file || now() - failedAt < FILE_RETRY_MS || !mayWork(entry.itemId)) continue;
          worked.add(entry.itemId);
          if (await fileEntry(entry.itemId, [entry.url])) files += 1;
          else store.setGifFileFailed(entry.itemId, now());
        }
        if (worked.size > 0) log.info('gif-keeper: settled', { placeId, worked: worked.size, vectors, files });
      });
    },
  };
}
