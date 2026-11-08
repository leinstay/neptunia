// The files of the owner's command line chat kept in the persona's data folder, under `media/cli/`, as the selfreflection
// keeps its pictures under `media/selfreflection/`. A chat client's staged file lasts a week (src/media/staging.ts), so
// the core copies each file of a line into this folder, and the line's `media` row names the copy in `path`
// (src/memory/db/media-store.ts#mediaItemsOf). A kept file is named by a `neptunia-media:` reference, which
// `createKeptFetch` answers for the core's media readers as a server would. The chat client turns a reference into the
// file's path when the terminal cannot show the file (`openableLine`). src/chat/kept-media.ts keeps the files of both
// directions, and bin/chat-images.ts prints the path.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Attachment } from '../protocol/actions.ts';

/** A kept file: its path under the data folder, the reference the media readers open, and its type and size. */
export type KeptFile = { path: string; reference: string; contentType: string; bytes: number; sha1: string };

const SCHEME = 'neptunia-media:///';
const KEPT_DIR = 'media/cli';
/** A kept path: a plain id and an extension, so a reference never climbs out of the folder. */
const KEPT_PATH = /^media\/cli\/[A-Za-z0-9_-]+\.[a-z0-9]{1,8}$/;

/** The types of the files the chat carries, by extension; anything else is `application/octet-stream`. */
const TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  txt: 'text/plain',
  md: 'text/markdown',
  log: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  pdf: 'application/pdf',
  zip: 'application/zip',
};
const OCTETS = 'application/octet-stream';

const extensionOf = (name: string): string | null => /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? null;

/** The type a file's name declares, `application/octet-stream` for a name the table does not know. */
export function contentTypeOfName(name: string): string {
  const extension = extensionOf(name);
  return (extension === null ? undefined : TYPES[extension]) ?? OCTETS;
}

/** The extension a kept file takes: the one its type has, else its name's, else `bin`. */
function keptExtension(name: string, contentType: string | null): string {
  const byType = Object.entries(TYPES).find(([, type]) => type === contentType)?.[0];
  return byType ?? extensionOf(name) ?? 'bin';
}

/** The reference of a kept path. */
export const keptReference = (file: string): string => `${SCHEME}${file}`;

/** The kept path a reference names, null for any other address and for a path outside `media/cli/`. */
export function keptPathOf(reference: string): string | null {
  if (!reference.startsWith(SCHEME)) return null;
  const file = reference.slice(SCHEME.length);
  return KEPT_PATH.test(file) ? file : null;
}

/** The absolute path of the file a reference names in `dataDir`, null when it names none. */
export function keptLocation(dataDir: string, reference: string): string | null {
  const file = keptPathOf(reference);
  return file === null ? null : path.join(dataDir, ...file.split('/'));
}

/**
 * Writes `bytes` once to `media/cli/<id>.<ext>` of `dataDir`, through a temporary file and a rename, and answers what was
 * kept. `id` is a plain id the caller makes unique: a staged file's id, or a new one for a file she sends.
 */
export function keepFile({
  dataDir,
  id,
  bytes,
  name,
  contentType,
}: {
  dataDir: string;
  id: string;
  bytes: Uint8Array;
  name: string;
  contentType: string | null;
}): KeptFile {
  const file = `${KEPT_DIR}/${id}.${keptExtension(name, contentType)}`;
  if (!KEPT_PATH.test(file)) throw new Error(`cannot keep a file under the id "${id}"; use letters, digits, - and _`);
  const target = path.join(dataDir, ...file.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const partial = `${target}.${process.pid}.part`;
  try {
    fs.writeFileSync(partial, bytes, { mode: 0o600 });
    fs.renameSync(partial, target);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  return {
    path: file,
    reference: keptReference(file),
    contentType: contentType ?? contentTypeOfName(file),
    bytes: bytes.length,
    sha1: createHash('sha1').update(bytes).digest('hex'),
  };
}

const addressOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const STAGED = /^neptunia-staged:\/\/\/([A-Za-z0-9_-]+)$/;

/** The kept copy of a staged file: the inbound line kept it under the staged id, with the extension its type gives. */
function keptCopyOf(dataDir: string, address: string): string | null {
  const id = STAGED.exec(address)?.[1];
  if (id === undefined) return null;
  try {
    const name = fs.readdirSync(path.join(dataDir, ...KEPT_DIR.split('/'))).find((one) => one.startsWith(`${id}.`));
    return name === undefined ? null : path.join(dataDir, ...KEPT_DIR.split('/'), name);
  } catch {
    return null;
  }
}

/**
 * A `fetch` that answers a kept reference from `dataDir` and hands every other address to `next`. A staged reference
 * whose file was kept is answered from the copy, typed by its name, so a voice note reads as audio before the staged file
 * expires and after.
 */
export function createKeptFetch({ dataDir, next }: { dataDir: string; next: typeof fetch }): typeof fetch {
  return async (input, init) => {
    const address = addressOf(input);
    const copy = keptCopyOf(dataDir, address);
    if (!address.startsWith(SCHEME) && copy === null) return next(input, init);
    const file = copy ?? keptLocation(dataDir, address);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      if (file === null) return new Response(null, { status: 404 });
      bytes = new Uint8Array(await fs.promises.readFile(file));
    } catch {
      return new Response(null, { status: 404 });
    }
    const headers = { 'content-type': contentTypeOfName(file), 'content-length': `${bytes.length}` };
    return new Response(bytes, { status: 200, headers });
  };
}

/** The line that tells the owner where a file she sent lies, for a terminal that cannot show it; null with no kept copy. */
export function openableLine(dataDir: string, file: Pick<Attachment, 'name' | 'url' | 'data'>): string | null {
  const location = typeof file.url === 'string' ? keptLocation(dataDir, file.url) : null;
  return location === null ? null : `[file ${file.name}] ${location}`;
}
