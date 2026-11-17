// The text of a text attachment as a request shows it, fetched lazily over plain HTTP: only ever called for a message
// that ends up inside a real request (src/behavior/prompt.js, src/memory/update.ts), never while a message is read.

import { log } from '../log.ts';
import type { Summarize } from '../behavior/summarize.ts';

/** Never fetch a bigger "text" attachment than this. */
const TEXT_PREVIEW_SIZE_GUARD = 256 * 1024;

type Fetch = (url: string) => Promise<{
  ok: boolean;
  headers?: { get?(name: string): string | null };
  text(): Promise<string>;
}>;

type Attachment = { id?: string; kind?: string; url?: string; previewText?: string; previewRetold?: boolean };
type Message = { attachments?: Array<Attachment> };
/** What a preview takes beside its address: the summarizer that retells a text over `maxChars` (none keeps it whole). */
type PreviewOptions = { summarize?: Summarize | undefined };

/**
 * A text attachment's content: whole when it fits `maxChars`, else `summarize`'s one retelling of it, and whole with
 * no `summarize`. A response bigger than 256 KB, or any fetch failure, returns `null` so the caller falls back to the
 * plain `file` form.
 */
export async function fetchTextPreview(
  url: string,
  maxChars: number,
  fetchImpl: Fetch = fetch,
  { summarize }: PreviewOptions = {}
): Promise<string | null> {
  return (await fetchPreview(url, maxChars, fetchImpl, summarize))?.text ?? null;
}

/** `fetchTextPreview`'s body: `{ text, retold }` (`retold`: the text is a summary of a longer file), or null. */
async function fetchPreview(
  url: string,
  maxChars: number,
  fetchImpl: Fetch,
  summarize: Summarize | undefined
): Promise<{ text: string; retold: boolean } | null> {
  let text: string;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const declaredSize = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > TEXT_PREVIEW_SIZE_GUARD) return null;
    text = await response.text();
    if (!Number.isFinite(declaredSize) && Buffer.byteLength(text, 'utf8') > TEXT_PREVIEW_SIZE_GUARD) return null;
  } catch (err) {
    log.warn('collect: text attachment preview fetch failed', { error: err });
    return null;
  }
  if (!summarize || Array.from(text).length <= maxChars) return { text, retold: false };
  const told = await summarize(text, { maxChars, kind: 'text' });
  return { text: told, retold: told !== text };
}

/**
 * A shallow-cloned copy of `messages` with `previewText` filled in on every `kind: 'text'` attachment that does not
 * have one yet (best effort, in parallel, never mutates the input). A preview that is the summarizer's retelling of a
 * file over `maxChars` also carries `previewRetold: true`, and the transcript names it as a retelling.
 */
export async function withTextPreviews<M extends Message>(
  messages: ReadonlyArray<M>,
  maxChars: number,
  fetchImpl: Fetch = fetch,
  { summarize }: PreviewOptions = {}
): Promise<Array<M>> {
  return Promise.all(
    messages.map(async (message) => {
      const textAttachments = (message.attachments ?? []).filter((a) => a.kind === 'text' && !a.previewText);
      if (textAttachments.length === 0) return message;
      const previews = await Promise.all(
        textAttachments.map((a) => fetchPreview(a.url ?? '', maxChars, fetchImpl, summarize))
      );
      const byId = new Map(textAttachments.map((a, i) => [a.id, previews[i]]));
      return {
        ...message,
        attachments: (message.attachments ?? []).map((a) => {
          const preview = byId.get(a.id);
          if (!preview) return a;
          return preview.retold
            ? { ...a, previewText: preview.text, previewRetold: true }
            : { ...a, previewText: preview.text };
        }),
      };
    })
  );
}
