// How the describer (src/memory/describe.ts) tells a voice message, an audio file and a text file: the first two heard on the
// `video` role through `describe-audio`, the third from its own words with no model. What it comes to is a transcript, in the
// language spoken: quoted speech, so the script check of a picture's description does not apply.

import { clampText } from './clamp.ts';

/** A voice message or an audio file, or a text file, as the collectors list them. */
type Item = { itemId: string; kind: string; url: string; durationSec?: number | null };
/** The live `media.video` section with its fixed fields. */
type VideoSettings = {
  summaryChars: number;
  maxSeconds: number;
  maxBytes: number;
  toolTimeoutMs: number;
  ffmpegPath: string;
  maxOutputTokens: number;
  provider?: unknown;
};
type Clip = { ok: true; dataUrl: string; seconds: number; bytes: number } | { ok: false; reason: string };
export type Completion = { text?: unknown; usage?: unknown; estimated?: unknown };

/** What the describer gives this module, read at the moment of use. */
export type AudioDeps = {
  prompt: () => unknown;
  settings: () => VideoSettings;
  model: () => string | null | undefined;
  fill: (template: string, values: Record<string, unknown>) => string;
  fetchAudio: (url: string, options: Record<string, unknown>) => Promise<Clip>;
  fetchText: (url: string) => Promise<{ ok: boolean; text?: string; reason?: string }>;
  complete: (messages: Array<unknown>, options: unknown) => Promise<Completion>;
  requestOptions: (settings: VideoSettings, seconds: number, model: unknown) => object;
  failureReason: (error: unknown) => string;
  keep: (item: Item, entry: Record<string, unknown>) => void;
  miss: (item: Item, reason: unknown) => null;
  now: () => number;
};

/** The first characters of a text file kept as its text form, a preview's own length. */
export const TEXT_FORM_CHARS = 2000;

/**
 * How an audio file goes in a request: the one place its packaging lives. The `video` role takes a clip, so the file is carried
 * as a `video_url` part holding what src/media/fetch-video.ts#fetchAudio made of it.
 */
function audioPart(dataUrl: string): object {
  return { type: 'video_url', video_url: { url: dataUrl } };
}

/** The text form of a heard file; null when it cannot be had, its cause kept on a miss. */
export async function hearAudio(
  deps: AudioDeps,
  item: Item
): Promise<{ text: string; usage: unknown; estimated: number } | null> {
  const promptText = deps.prompt();
  if (typeof promptText !== 'string' || !promptText) return null;
  const settings = deps.settings();
  const clip = await deps.fetchAudio(item.url, {
    durationSec: item.durationSec,
    maxSeconds: settings.maxSeconds,
    maxBytes: settings.maxBytes,
    toolTimeoutMs: settings.toolTimeoutMs,
    ffmpegPath: settings.ffmpegPath,
  });
  if (!clip.ok) return deps.miss(item, clip.reason);
  const maxChars = settings.summaryChars;
  const model = deps.model();
  let completion: Completion;
  try {
    completion = await deps.complete(
      [
        { role: 'system', content: deps.fill(promptText, { maxChars }) },
        { role: 'user', content: [audioPart(clip.dataUrl)] },
      ],
      { ...deps.requestOptions(settings, clip.seconds, model), provider: settings.provider }
    );
  } catch (error) {
    const reason = deps.failureReason(error);
    // A refusal by the daily cap says nothing about the file: heard after the reset.
    return reason === 'daily-cap' ? null : deps.miss(item, reason);
  }
  const heard = typeof completion.text === 'string' ? completion.text : '';
  const text = clampText(heard.trim(), maxChars, { tolerance: 1 });
  if (!text) return deps.miss(item, 'empty');
  const ts = deps.now();
  deps.keep(item, { text, ts, describedAt: ts, model });
  return {
    text,
    usage: completion.usage ?? null,
    estimated: typeof completion.estimated === 'number' ? completion.estimated : 0,
  };
}

/** A text file's text form is the opening of its own words, with no model. */
export async function readTextFile(
  deps: AudioDeps,
  item: Item
): Promise<{ text: string; usage: null; estimated: number } | null> {
  const read = await deps.fetchText(item.url);
  if (!read.ok || !read.text) return deps.miss(item, read.reason ?? 'download');
  const ts = deps.now();
  const text = read.text.trim().slice(0, TEXT_FORM_CHARS);
  deps.keep(item, { text, ts, describedAt: ts });
  return { text, usage: null, estimated: 0 };
}
