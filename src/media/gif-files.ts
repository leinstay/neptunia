// The cached file of a library GIF: the bytes under `media/gifs/` of the data folder, named by their hash, so the same
// GIF from another link is one file. Attachment links expire, so the file is the record. The library's keeper
// (src/memory/gif-keeper.ts) calls this with `createGifFetcher`'s download; no wording here.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bareContentType } from './video-sites.ts';

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
