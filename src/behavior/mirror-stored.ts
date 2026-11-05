// A diary entry as memory holds it, for a publication that goes out after the turn that wrote it: her messages as first
// sent (the publication's `delivery`, else the `diary` row's `send`, else the rendered text as one message) and its
// `media` rows with their files under the data directory, in their numbering: the pictures, the voice file and the files
// of her messages. A file that cannot be read makes the entry `missing`: the publisher posts nothing of it, since a
// partial post could not be completed later.

import { entryMedia } from '../memory/db/media-store.ts';
import fs from 'node:fs';
import path from 'node:path';
import { deliveryOf } from '../memory/db/publication-delivery.ts';
import { diaryMetadataOf, isPublicationBoundary } from '../tools/publication.ts';
import type { Db, Row } from '../memory/db/types.ts';
import type { DiaryEntry, EntryFile, EntryPicture, Publication } from './mirror.ts';

/** The code an error carries, or `fallback`. */
export function errorCode(err: unknown, fallback: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : fallback;
}

/** The JSON object of `text`, or an empty object. */
function objectOf(text: unknown): Row {
  try {
    const parsed: unknown = typeof text === 'string' ? JSON.parse(text) : null;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Row) : {};
  } catch {
    // An unreadable extra holds nothing of the entry.
    return {};
  }
}

/** What a stored entry comes to: the entry, whether a file of it is gone, and whether it has any content yet. */
export type StoredEntry = { entry: DiaryEntry; missing: boolean; hasContent: boolean };

/** The entry's `media` rows as its parts; `missing` when one has no readable file. */
function storedMedia(
  db: Db,
  id: string,
  dataDir: string | null
): { pictures: Array<EntryPicture>; files: Array<EntryFile>; voice: DiaryEntry['voice']; missing: boolean } {
  const media = entryMedia(db, id);
  const pictures: Array<EntryPicture> = [];
  const files: Array<EntryFile> = [];
  let voice: DiaryEntry['voice'] = null;
  let missing = false;
  for (const item of media) {
    const file = dataDir && typeof item.path === 'string' ? path.join(dataDir, item.path) : null;
    if (!file || !fs.existsSync(file)) {
      missing = true;
      continue;
    }
    const buffer = fs.readFileSync(file);
    const mime = String(item.mime);
    const extra = objectOf(item.extra);
    const own = extra.file as { message?: unknown; name?: unknown } | undefined;
    if (own && typeof own.message === 'number') {
      const name = typeof own.name === 'string' ? own.name : 'file';
      files.push({ message: own.message, name, data: buffer, contentType: mime });
    } else if (mime.startsWith('audio/')) {
      const durationSecs = typeof extra.durationSec === 'number' ? extra.durationSec : 0;
      voice = { ogg: buffer, durationSecs, waveform: typeof extra.waveform === 'string' ? extra.waveform : '' };
    } else pictures.push({ buffer, mediaType: mime });
  }
  return { pictures, files, voice, missing };
}

/** The entry of a publication as memory holds it (see the head of this file). */
export function storedEntry(db: Db, publication: Publication, dataDir: string | null): StoredEntry {
  const row = db.prepare('SELECT extra FROM diary WHERE id = ?').get(publication.row_id);
  const metadata = diaryMetadataOf(row?.extra);
  const send = metadata.send as { messages?: unknown; mentions?: unknown; maxMessageBytes?: unknown } | undefined;
  const delivered = deliveryOf(publication);
  const given = Array.isArray(send?.messages) ? (send.messages as Array<string>) : null;
  const messages = delivered.messages ?? given ?? [publication.rendered ?? ''];
  const mentions =
    delivered.mentions ?? (Array.isArray(send?.mentions) ? (send.mentions as Array<Array<string>>) : null);
  const { pictures, files, voice, missing } = storedMedia(db, publication.row_id, dataDir);
  return {
    entry: {
      id: publication.row_id,
      ...(isPublicationBoundary(metadata.publicationBoundary)
        ? { publicationBoundary: metadata.publicationBoundary }
        : {}),
      messages,
      ...(mentions ? { mentions } : {}),
      ...(typeof send?.maxMessageBytes === 'number' ? { maxMessageBytes: send.maxMessageBytes } : {}),
      ...(pictures.length > 0 ? { pictures } : {}),
      ...(voice ? { voice } : {}),
      ...(files.length > 0 ? { files } : {}),
    },
    missing,
    hasContent: delivered.messages !== undefined || given !== null || publication.rendered !== null,
  };
}

/** What a publication prepared by a scan renders: her messages as first sent, else the entry's text as one message. */
export function scannedMessages(extra: unknown, text: string | null): Array<string> {
  const send = diaryMetadataOf(extra).send as { messages?: unknown } | undefined;
  return Array.isArray(send?.messages) ? (send.messages as Array<string>) : [text ?? ''];
}
