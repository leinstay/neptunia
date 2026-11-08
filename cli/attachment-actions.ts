// What the owner can do with an image the persona sent: save it, open it with the platform's viewer, read its text
// alternative. The same opener and a copy reach any kept file of a numbered line, for `/attach open #N` and
// `/attach save #N`. A received name is data: it reaches no shell, the temporary file of `open` carries none of it, and a
// saved file takes only its last path segment. Reads and writes come from the caller (bin/chat-images.ts), and
// cli/chat-controller.ts runs these for the `/attach` commands.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProcessRun } from './clipboard.ts';
import type { ChatAttachment } from './composer.ts';

export type AttachmentOutcome =
  { status: 'saved'; file: string } | { status: 'opened' } | { status: 'failed'; retry: boolean; reason: string };

export type AttachmentActions = {
  save(attachment: ChatAttachment, destination: string): Promise<AttachmentOutcome>;
  open(attachment: ChatAttachment): Promise<AttachmentOutcome>;
  alternative(attachment: ChatAttachment): string;
  /** Opens the file at `file`, an absolute path on this machine, with the platform's opener. */
  openFile(file: string): Promise<AttachmentOutcome>;
  /** Copies the file at `file` into `directory` under `name`, never over a file already there. */
  saveFile(file: string, directory: string, name: string): Promise<AttachmentOutcome>;
};

const OPENERS: Readonly<Record<string, string>> = { linux: 'xdg-open', darwin: 'open' };
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
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

/** A received name as one file name: its last segment, with nothing that climbs out of the folder. */
function fileNameOf(name: string, file: string): string {
  const last = name.split(/[\\/]/).at(-1) ?? '';
  return last === '' || last === '.' || last === '..' ? path.basename(file) : last;
}

export function createAttachmentActions({
  read,
  writeFile,
  run,
  platform,
  tempDir,
  copyFile = copyOnce,
}: {
  read: (attachment: ChatAttachment) => Promise<Uint8Array | null>;
  writeFile: (file: string, bytes: Uint8Array) => Promise<void>;
  run: ProcessRun;
  platform: string;
  tempDir: string;
  /** Copies a kept file to where the owner saves it; the default refuses to replace a file. */
  copyFile?: (from: string, to: string) => Promise<void>;
}): AttachmentActions {
  /** Runs the platform's opener on `file`. */
  async function openWith(file: string): Promise<AttachmentOutcome> {
    const opener = OPENERS[platform];
    if (opener === undefined) return { status: 'failed', retry: false, reason: `no viewer known for ${platform}` };
    const result = await run([opener, file]);
    if (result.code === 0) return { status: 'opened' };
    const reason = result.missing === true ? `${opener} is not installed` : `${opener} exited with ${result.code}`;
    return { status: 'failed', retry: false, reason };
  }
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
    async open(attachment) {
      if (OPENERS[platform] === undefined) return openWith('');
      const bytes = await read(attachment);
      if (bytes === null) return GONE;
      const extension = EXTENSIONS[attachment.contentType] ?? 'bin';
      const file = path.join(tempDir, `open-${randomUUID()}.${extension}`);
      try {
        await writeFile(file, bytes);
        return await openWith(file);
      } catch (error) {
        return { status: 'failed', retry: true, reason: messageOf(error) };
      }
    },
    alternative: alternativeText,
    async openFile(file) {
      try {
        return await openWith(file);
      } catch (error) {
        return { status: 'failed', retry: true, reason: messageOf(error) };
      }
    },
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
