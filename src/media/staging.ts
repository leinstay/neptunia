// Images on their way between the owner's terminal and the core, kept in one private folder of the data root. The core's
// media readers take URLs, so a staged image is named by a `neptunia-staged:` reference, and `fetch` answers such a
// reference as a server would and passes every other address on. A file is read once when it is staged, so the owner may
// delete it afterwards. The content type of a picture comes from the bytes; `stageAttachment` also stages any other file of
// the command line, typed by its name (src/media/kept-files.ts#contentTypeOfName). A staged file's modification time is the moment it was
// staged by the injected clock, and `sweep` removes what outlived `ttlMs`, so a retried turn still finds its image. The
// chat (bin/chat-images.ts) writes here and the core's image fetcher (src/core.ts) reads, two processes of one user.

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { VISION_MAX_BYTES } from './fetch-image.ts';
import { contentTypeOfName } from './kept-files.ts';

export type StagedImage = { id: string; name: string; contentType: string; reference: string; size: number };
export type StageResult = { ok: true; staged: StagedImage } | { ok: false; code: StageRefusal };
export type StageRefusal = 'invalid-image' | 'too-large' | 'vanished' | 'failed';

export type ImageStaging = {
  stageBytes(bytes: Uint8Array, details: { name: string }): Promise<StageResult>;
  stageFile(file: string): Promise<StageResult>;
  /** A file of any kind for the command line: a picture as `stageFile` stages it, anything else typed by its name. */
  stageAttachment(file: string): Promise<StageResult>;
  /** The staged bytes, null when the id is unknown or released. A read leaves them for the next one. */
  read(id: string): Promise<Uint8Array | null>;
  release(id: string): Promise<void>;
  /** Removes what outlived the lifetime and answers how many images went. */
  sweep(): Promise<number>;
  /** A `fetch` for the core's readers: a reference from this folder, anything else from the network. */
  fetch: typeof fetch;
};

/** One week, decided 2026-11-05: a paused core keeps a line until `/resume`, and its image has to outlast that. */
export const STAGING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The largest file that is no picture: one file of the socket's frame, as src/protocol/wire.ts sizes it. */
export const FILE_MAX_BYTES = 10 * 1024 * 1024;

const SCHEME = 'neptunia-staged:///';
const ID = /^[A-Za-z0-9_-]+$/;
const WEBP_OFFSET = 8;

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>, offset = 0): boolean =>
  prefix.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string): Array<number> => Array.from(text, (char) => char.charCodeAt(0));

/** The image type the bytes themselves declare, of the four the media readers accept. */
function imageTypeOf(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), WEBP_OFFSET)) return 'image/webp';
  return null;
}

/** The id inside a reference, null for any other address. */
export function stagedIdOf(reference: string): string | null {
  if (!reference.startsWith(SCHEME)) return null;
  const id = reference.slice(SCHEME.length);
  return ID.test(id) ? id : null;
}

/** The folder of the data root that holds staged images. */
export const stagingDir = (dataDir: string): string => path.join(dataDir, 'staging', 'images');

const addressOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

export function createImageStaging({
  dir,
  now,
  newId,
  ttlMs,
  maxBytes,
}: {
  dir: string;
  now: () => number;
  newId: () => string;
  ttlMs: number;
  maxBytes: number;
}): ImageStaging {
  const fileOf = (id: string): string => path.join(dir, id);

  async function stageBytes(bytes: Uint8Array, { name }: { name: string }): Promise<StageResult> {
    if (bytes.length > maxBytes) return { ok: false, code: 'too-large' };
    const contentType = imageTypeOf(bytes);
    if (contentType === null) return { ok: false, code: 'invalid-image' };
    return write(bytes, name, contentType);
  }

  async function write(bytes: Uint8Array, name: string, contentType: string): Promise<StageResult> {
    const id = newId();
    const temporary = `${fileOf(id)}.tmp`;
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700);
      await fs.writeFile(temporary, bytes, { mode: 0o600 });
      const stagedAt = new Date(now());
      await fs.utimes(temporary, stagedAt, stagedAt);
      await fs.rename(temporary, fileOf(id));
    } catch {
      await fs.rm(temporary, { force: true });
      return { ok: false, code: 'failed' };
    }
    return { ok: true, staged: { id, name, contentType, reference: `${SCHEME}${id}`, size: bytes.length } };
  }

  async function stageFile(file: string): Promise<StageResult> {
    let bytes: Buffer;
    try {
      const { size } = await fs.stat(file);
      if (size > maxBytes) return { ok: false, code: 'too-large' };
      bytes = await fs.readFile(file);
    } catch {
      return { ok: false, code: 'vanished' };
    }
    return stageBytes(bytes, { name: path.basename(file) });
  }

  async function stageAttachment(file: string): Promise<StageResult> {
    let bytes: Buffer;
    try {
      const { size } = await fs.stat(file);
      if (size > Math.max(maxBytes, FILE_MAX_BYTES)) return { ok: false, code: 'too-large' };
      bytes = await fs.readFile(file);
    } catch {
      return { ok: false, code: 'vanished' };
    }
    const name = path.basename(file);
    const declared = contentTypeOfName(name);
    // A name that claims a picture must carry one: a text file named .png would reach the describer as an empty picture.
    if (imageTypeOf(bytes) !== null || declared.startsWith('image/')) return stageBytes(bytes, { name });
    if (bytes.length > FILE_MAX_BYTES) return { ok: false, code: 'too-large' };
    return write(bytes, name, declared);
  }

  async function read(id: string): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!ID.test(id)) return null;
    try {
      return new Uint8Array(await fs.readFile(fileOf(id)));
    } catch {
      return null;
    }
  }

  return {
    stageBytes,
    stageFile,
    stageAttachment,
    read,
    async release(id) {
      if (ID.test(id)) await fs.rm(fileOf(id), { force: true });
    },
    async sweep() {
      let names: Array<string>;
      try {
        names = await fs.readdir(dir);
      } catch {
        return 0;
      }
      let removed = 0;
      for (const name of names) {
        const file = path.join(dir, name);
        try {
          const { mtimeMs } = await fs.stat(file);
          if (now() - mtimeMs <= ttlMs) continue;
          await fs.rm(file, { force: true });
          removed += 1;
        } catch {
          // Another process removed it first, and the sweep is after the same result.
        }
      }
      return removed;
    },
    async fetch(input, init) {
      const address = addressOf(input);
      if (!address.startsWith(SCHEME)) return fetch(input, init);
      const id = stagedIdOf(address);
      const bytes = id === null ? null : await read(id);
      if (bytes === null) return new Response(null, { status: 404 });
      const headers = {
        'content-type': imageTypeOf(bytes) ?? 'application/octet-stream',
        'content-length': `${bytes.length}`,
      };
      return new Response(bytes, { status: 200, headers });
    },
  };
}

/** The staging of a data root, as the chat and the core open it; `maxBytes` is what the vision reader takes. */
export function openImageStaging(dataDir: string, maxBytes: number = VISION_MAX_BYTES): ImageStaging {
  return createImageStaging({
    dir: stagingDir(dataDir),
    now: Date.now,
    newId: randomUUID,
    ttlMs: STAGING_TTL_MS,
    maxBytes,
  });
}
