// The text of a text attachment as a request shows it, fetched lazily over plain HTTP: only ever called for a message
// that ends up inside a real request (src/behavior/prompt.js, src/memory/update.js), never while a message is read.

import { log } from '../log.js';

/** Never fetch a bigger "text" attachment than this. */
const TEXT_PREVIEW_SIZE_GUARD = 256 * 1024;

type Fetch = (url: string) => Promise<{
  ok: boolean;
  headers?: { get?(name: string): string | null };
  text(): Promise<string>;
}>;

type Attachment = { id?: string; kind?: string; url?: string; previewText?: string; previewLost?: number };
type Message = { attachments?: Array<Attachment> };

/**
 * The first `maxChars` characters of a text attachment's content. A response bigger than 256 KB, or any fetch failure,
 * returns `null` so the caller falls back to the plain `file` form.
 */
export async function fetchTextPreview(
  url: string,
  maxChars: number,
  fetchImpl: Fetch = fetch
): Promise<string | null> {
  return (await fetchPreview(url, maxChars, fetchImpl))?.text ?? null;
}

/** `fetchTextPreview`'s body: `{ text, lost }` (`lost`: the characters past `maxChars` left out), or null. */
async function fetchPreview(
  url: string,
  maxChars: number,
  fetchImpl: Fetch
): Promise<{ text: string; lost: number } | null> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const declaredSize = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > TEXT_PREVIEW_SIZE_GUARD) return null;
    const text = await response.text();
    if (!Number.isFinite(declaredSize) && Buffer.byteLength(text, 'utf8') > TEXT_PREVIEW_SIZE_GUARD) return null;
    const preview = text.slice(0, maxChars);
    return { text: preview, lost: text.length - preview.length };
  } catch (err) {
    log.warn('collect: text attachment preview fetch failed', { error: err });
    return null;
  }
}

/**
 * A shallow-cloned copy of `messages` with `previewText` filled in on every `kind: 'text'` attachment that does not
 * have one yet (best effort, in parallel, never mutates the input). A preview cut at `maxChars` also carries
 * `previewLost`: the characters left out (the turn's journal names the cut).
 */
export async function withTextPreviews<M extends Message>(
  messages: ReadonlyArray<M>,
  maxChars: number,
  fetchImpl: Fetch = fetch
): Promise<Array<M>> {
  return Promise.all(
    messages.map(async (message) => {
      const textAttachments = (message.attachments ?? []).filter((a) => a.kind === 'text' && !a.previewText);
      if (textAttachments.length === 0) return message;
      const previews = await Promise.all(textAttachments.map((a) => fetchPreview(a.url ?? '', maxChars, fetchImpl)));
      const byId = new Map(textAttachments.map((a, i) => [a.id, previews[i]]));
      return {
        ...message,
        attachments: (message.attachments ?? []).map((a) => {
          const preview = byId.get(a.id);
          if (!preview) return a;
          return preview.lost > 0
            ? { ...a, previewText: preview.text, previewLost: preview.lost }
            : { ...a, previewText: preview.text };
        }),
      };
    })
  );
}
