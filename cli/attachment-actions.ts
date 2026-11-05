// What the owner can do with an image the persona sent: save it, open it with the platform's viewer, read its text
// alternative. A received name is data: it reaches no shell, and the temporary file of `open` carries none of it. Reads and
// writes come from the caller (bin/chat-images.ts), and cli/app.ts runs these for `/attach open` and `/attach save`.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProcessRun } from './clipboard.ts';
import type { ChatAttachment } from './composer.ts';

export type AttachmentOutcome =
  { status: 'saved'; file: string } | { status: 'opened' } | { status: 'failed'; retry: boolean; reason: string };

export type AttachmentActions = {
  save(attachment: ChatAttachment, destination: string): Promise<AttachmentOutcome>;
  open(attachment: ChatAttachment): Promise<AttachmentOutcome>;
  alternative(attachment: ChatAttachment): string;
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

export function createAttachmentActions({
  read,
  writeFile,
  run,
  platform,
  tempDir,
}: {
  read: (attachment: ChatAttachment) => Promise<Uint8Array | null>;
  writeFile: (file: string, bytes: Uint8Array) => Promise<void>;
  run: ProcessRun;
  platform: string;
  tempDir: string;
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
    async open(attachment) {
      const opener = OPENERS[platform];
      if (opener === undefined) return { status: 'failed', retry: false, reason: `no viewer known for ${platform}` };
      const bytes = await read(attachment);
      if (bytes === null) return GONE;
      const extension = EXTENSIONS[attachment.contentType] ?? 'bin';
      const file = path.join(tempDir, `open-${randomUUID()}.${extension}`);
      try {
        await writeFile(file, bytes);
        const result = await run([opener, file]);
        if (result.code === 0) return { status: 'opened' };
        const reason = result.missing === true ? `${opener} is not installed` : `${opener} exited with ${result.code}`;
        return { status: 'failed', retry: false, reason };
      } catch (error) {
        return { status: 'failed', retry: true, reason: messageOf(error) };
      }
    },
    alternative: alternativeText,
  };
}
