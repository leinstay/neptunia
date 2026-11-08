// The files of the owner's command line chat kept in the persona's data folder, both ways, so every picture, GIF, video,
// voice note or other file of the chat stays with its line as a platform's attachment does. `keepLineFiles` wraps the
// door the chat's lines pass: each staged file of a line the owner sends is copied under `media/cli/<staged id>`
// (src/media/kept-files.ts), and the line names the copy by its kept reference, which the line's `media` row stores as
// its `path`. `withKeptSends` wraps the chat client's adapter: a file she sends is kept before the client gets it, the
// client gets the kept reference beside the bytes, so a terminal that cannot show the file prints its path, and her line
// comes back to the core through `echo` as a platform echoes a message she posted, so memory stores the line with its
// files. src/core.ts builds both; descriptions come from the describer as for any interface.

import fs from 'node:fs';
import path from 'node:path';
import { classifyAttachment } from '../media/classify.ts';
import { keepFile } from '../media/kept-files.ts';
import type { KeptFile } from '../media/kept-files.ts';
import { envelope } from '../protocol/envelope.ts';
import type { LinkDoor } from '../interface/link.ts';
import type { Attachment, Content } from '../protocol/actions.ts';
import type { Adapter, ChatRef, Delivery, MessageEvent } from '../protocol/adapter.ts';

const CLI = 'cli';
const STAGED = /^neptunia-staged:\/\/\/([A-Za-z0-9_-]+)$/;

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** One attachment of a line with its staged file kept: the same item, its address the kept copy. */
async function keptAttachment(
  attachment: unknown,
  { dataDir, readStaged }: { dataDir: string; readStaged: (id: string) => Promise<Uint8Array | null> }
): Promise<unknown> {
  if (!isObject(attachment)) return attachment;
  const id = STAGED.exec(text(attachment.url) ?? '')?.[1];
  if (id === undefined) return attachment;
  const bytes = await readStaged(id);
  if (bytes === null) return attachment;
  const kept = keepFile({
    dataDir,
    id,
    bytes,
    name: text(attachment.name) ?? id,
    contentType: text(attachment.contentType),
  });
  return { ...attachment, url: kept.reference };
}

/** `door` with the staged files of every command line line kept first. A file that cannot be kept stays as it came. */
export function keepLineFiles(
  door: LinkDoor,
  deps: { dataDir: string; readStaged: (id: string) => Promise<Uint8Array | null> }
): LinkDoor {
  return {
    async receive(value, from) {
      const envelope = isObject(value) ? value : {};
      const body = isObject(envelope.body) ? envelope.body : {};
      const message = isObject(body.message) ? body.message : null;
      if (envelope.type !== 'event' || body.kind !== 'message.received' || body.iface !== CLI || message === null)
        return door.receive(value, from);
      const given = Array.isArray(message.attachments) ? (message.attachments as Array<unknown>) : [];
      const attachments = await Promise.all(given.map((one) => keptAttachment(one, deps).catch(() => one)));
      return door.receive({ ...envelope, body: { ...body, message: { ...message, attachments } } }, from);
    },
  };
}

/** Her line as the chat would echo it: the message the send made, with her words and the kept files. */
function echoOf(
  chat: ChatRef,
  messageId: string,
  at: number,
  content: Content,
  files: ReadonlyArray<Sent>
): MessageEvent {
  return {
    kind: 'message.received',
    iface: chat.iface,
    at,
    id: `${chat.iface}:message:${messageId}`,
    chat: { id: chat.chatId, kind: 'dm', rootId: null, name: 'owner', partnerId: 'owner' },
    message: {
      id: messageId,
      author: { id: 'self', name: null, self: true, bot: false },
      content: content.text ?? '',
      sourceText: content.text ?? '',
      system: false,
      at,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: files.map(({ id, file, kept }) => ({
        id,
        kind: classifyAttachment({ contentType: kept.contentType, name: file.name, isVoice: file.voice !== undefined }),
        url: kept.reference,
        name: file.name,
        contentType: kept.contentType,
        size: kept.bytes,
        width: null,
        height: null,
        durationSec: file.voice?.durationSecs ?? null,
      })),
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

/** A file of a send with what was kept of it. */
type Sent = { id: string; file: Attachment; kept: KeptFile };

/**
 * `live`, the chat client's adapter, with the files of every send to a command line chat kept, and her line handed to
 * `echo` once the client took it. A send the client refused keeps nothing and echoes nothing.
 */
export function withKeptSends(
  live: Adapter,
  deps: {
    dataDir: string;
    newId: () => string;
    echo: (event: MessageEvent) => unknown;
  }
): Adapter {
  return {
    ...live,
    iface: live.iface,
    capabilities: () => live.capabilities(),
    async send(chat, content, options) {
      const files = (content.attachments ?? []).filter((file) => file.data !== undefined);
      if (chat.iface !== CLI || files.length === 0) return live.send(chat, content, options);
      const sent: Array<Sent> = files.map((file) => {
        const id = deps.newId();
        const data = file.data ?? new Uint8Array();
        const kept = keepFile({
          dataDir: deps.dataDir,
          id,
          bytes: data,
          name: file.name,
          contentType: file.contentType ?? null,
        });
        return { id, file, kept };
      });
      const urlOf = new Map(sent.map(({ file, kept }) => [file, kept.reference]));
      const attachments = (content.attachments ?? []).map((file) => {
        const url = urlOf.get(file);
        return url === undefined ? file : { ...file, url };
      });
      const delivery: Delivery = await live.send(chat, { ...content, attachments }, options);
      const messageId = delivery.ref?.messageId ?? null;
      if (delivery.status !== 'ok' || messageId === null) {
        for (const { kept } of sent) removeKept(deps.dataDir, kept.path);
        return delivery;
      }
      await deps.echo(echoOf(chat, messageId, delivery.at ?? Date.now(), content, sent));
      return { ...delivery, attachments: sent.map(({ id }) => ({ messageId, attachmentId: id })) };
    },
  };
}

/** Removes a kept file nobody received. */
function removeKept(dataDir: string, file: string): void {
  fs.rmSync(path.join(dataDir, ...file.split('/')), { force: true });
}

/** The `echo` of `withKeptSends` through `door`: her line as the chat's principal would send it, so memory takes it as the chat's. */
export function echoThrough(door: LinkDoor): (event: MessageEvent) => Promise<unknown> {
  return (event) =>
    door.receive(envelope('event', event, { id: `echo:${event.id}` }), {
      principal: CLI,
      authenticated: { name: CLI, kind: 'cli' },
    });
}
