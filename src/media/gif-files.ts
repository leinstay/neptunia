// The stored file of a library GIF: the bytes under `media/gifs/` of the data folder, named by their hash, so the same
// GIF from another link is one file. Attachment links expire, so the file is the spare copy. `fileGifs` downloads it when
// the GIF appears, from the direct media address a link GIF's entry holds (`fileUrl`) or an attachment's own address
// of that sighting: the media prefill of a message
// (src/pipeline/media-prefill.ts) and the history backfill (src/memory/gif-backfill.ts) call it with `createGifFetcher`'s
// download. No wording here.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bareContentType } from './video-sites.ts';
import { normalizeGifs } from '../memory/gifs.ts';

/** The largest GIF kept, in bytes. An interface still refuses what it cannot post. */
const GIF_MAX_BYTES = 16 * 1024 * 1024;

/** What a GIF file may be, and the extension it is kept under. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/** The bytes of a download, null when there are none to keep. */
export type GifBytes = { bytes: Uint8Array; contentType?: string } | null;

/**
 * The file of the GIF at `url`: fetched, written once under `media/gifs/<sha256>.<ext>` and answered as its hash and
 * its path relative to the data folder. A failed fetch or no bytes answers null and writes nothing.
 */
export async function cacheGifFile({
  url,
  dataDir,
  fetchBytes,
}: {
  url: string;
  dataDir: string;
  fetchBytes: (url: string) => Promise<GifBytes>;
}): Promise<{ hash: string; file: string } | null> {
  let fetched: GifBytes;
  try {
    fetched = await fetchBytes(url);
  } catch {
    return null;
  }
  if (!fetched || fetched.bytes.length === 0) return null;
  const hash = createHash('sha256').update(fetched.bytes).digest('hex');
  const extension = EXTENSIONS[bareContentType(fetched.contentType ?? '')] ?? 'gif';
  const file = path.posix.join('media', 'gifs', `${hash}.${extension}`);
  const target = path.join(dataDir, file);
  if (fs.existsSync(target)) return { hash, file };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.${process.pid}.part`;
  fs.writeFileSync(partial, fetched.bytes);
  fs.renameSync(partial, target);
  return { hash, file };
}

/** The library as `fileGifs` reads and writes it (src/memory/store.ts). */
type GifFileStore = {
  getGifs: () => unknown;
  setGifFile: (key: string, file: { hash: string; file: string }) => void;
};

/**
 * The files of the library GIFs of one sighting, one after another. An entry without a file gets it downloaded from the
 * direct media address it holds (a link GIF's `fileUrl`), else from the sighting's own `url` (an attached GIF's fresh
 * address), never from a page link. A failed download leaves the entry as it was, so the GIF's next sighting tries again.
 */
export async function fileGifs({
  store,
  dataDir,
  fetchBytes,
  items,
}: {
  store: GifFileStore;
  dataDir: string;
  fetchBytes: (url: string) => Promise<GifBytes>;
  items: Iterable<{ itemId: string; url?: string }>;
}): Promise<void> {
  for (const { itemId, url } of items) {
    // Read now: a file filed for an earlier item may have moved or joined this entry.
    const entries = Object.values(normalizeGifs(store.getGifs()).entries);
    const entry = entries.find((held) => held.nativeIds.includes(itemId));
    const address = entry?.fileUrl ?? url;
    if (!entry || entry.file || !address) continue;
    const cached = await cacheGifFile({ url: address, dataDir, fetchBytes });
    if (cached) store.setGifFile(itemId, cached);
  }
}

/**
 * The download of a GIF's file over `fetchImpl`, answering a media file only: a page, an address that is not http or a file
 * past the limit answers null, and a network failure throws (cacheGifFile answers null for both).
 */
export function createGifFetcher({ fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}): (
  url: string
) => Promise<GifBytes> {
  return async (url) => {
    if (!/^https?:\/\//i.test(url)) return null;
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const contentType = bareContentType(response.headers.get('content-type') ?? '');
    if (!EXTENSIONS[contentType]) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > GIF_MAX_BYTES ? null : { bytes, contentType };
  };
}
