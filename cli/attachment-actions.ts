// What the owner can do with a file of the chat: save an image she sent, read its text alternative, read the bytes the
// command window shows, and read or save a kept file of a numbered line, for `/attach open #N` and `/attach save #N`.
// Nothing here starts a process: the chat shows a file through the terminal itself (cli/chat-controller.ts). A received
// name is data, and a saved file takes only its last path segment. Reads and writes come from the caller
// (bin/chat-images.ts).
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatAttachment } from './composer.ts';

export type AttachmentOutcome =
  { status: 'saved'; file: string } | { status: 'failed'; retry: boolean; reason: string };

/** A kept file's size, and its bytes when it holds no more than the reader asked for. */
export type KeptRead = { size: number; bytes: Uint8Array | null };

export type AttachmentActions = {
  save(attachment: ChatAttachment, destination: string): Promise<AttachmentOutcome>;
  alternative(attachment: ChatAttachment): string;
  /** The bytes of an image she sent, null when they are no longer kept. */
  bytesOf(attachment: ChatAttachment): Promise<Uint8Array | null>;
  /** The size of the kept file at `file` and, up to `maxBytes`, its bytes; null when it cannot be read. */
  readKept(file: string, maxBytes: number): Promise<KeptRead | null>;
  /** Copies the file at `file` into `directory` under `name`, never over a file already there. */
  saveFile(file: string, directory: string, name: string): Promise<AttachmentOutcome>;
};

const GONE: AttachmentOutcome = { status: 'failed', retry: false, reason: 'the image is no longer kept' };

/** The image as text, for a terminal that cannot draw it and for a screen reader. */
export function alternativeText(attachment: ChatAttachment): string {
  const alt = attachment.alt ?? null;
  return alt === null ? `${attachment.name}: no description` : `${attachment.name}: ${alt}`;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');

/** A copy that refuses to replace a file already at `to`. */
const copyOnce = (from: string, to: string): Promise<void> => fs.copyFile(from, to, constants.COPYFILE_EXCL);

/** The size of a file, and its bytes when it holds no more than `maxBytes`. */
async function readFromDisk(file: string, maxBytes: number): Promise<KeptRead | null> {
  try {
    const { size } = await fs.stat(file);
    return { size, bytes: size <= maxBytes ? await fs.readFile(file) : null };
  } catch {
    return null;
  }
}

/** A received name as one file name: its last segment, with nothing that climbs out of the folder. */
function fileNameOf(name: string, file: string): string {
  const last = name.split(/[\\/]/).at(-1) ?? '';
  return last === '' || last === '.' || last === '..' ? path.basename(file) : last;
}

export function createAttachmentActions({
  read,
  writeFile,
  copyFile = copyOnce,
  readKept = readFromDisk,
}: {
  read: (attachment: ChatAttachment) => Promise<Uint8Array | null>;
  writeFile: (file: string, bytes: Uint8Array) => Promise<void>;
  /** Copies a kept file to where the owner saves it; the default refuses to replace a file. */
  copyFile?: (from: string, to: string) => Promise<void>;
  /** Reads a kept file; the default reads the disk of this machine. */
  readKept?: (file: string, maxBytes: number) => Promise<KeptRead | null>;
}): AttachmentActions {
  return {
    async save(attachment, destination) {
      const bytes = await read(attachment);
      if (bytes === null) return GONE;
      try {
        await writeFile(destination, bytes);
        return { status: 'saved', file: destination };
      } catch (error) {
        return { status: 'failed', retry: true, reason: messageOf(error) };
      }
    },
    alternative: alternativeText,
    bytesOf: read,
    readKept,
    async saveFile(file, directory, name) {
      const destination = path.join(directory, fileNameOf(name, file));
      try {
        await copyFile(file, destination);
        return { status: 'saved', file: destination };
      } catch (error) {
        return { status: 'failed', retry: true, reason: messageOf(error) };
      }
    },
  };
}
