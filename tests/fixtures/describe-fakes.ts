// The fakes of tests/describe.test.ts: the model, the two fetchers and the state the describer is given. Each records
// what it was asked and answers what the test set.
import type { Untyped } from '../../src/tools/types.ts';

export type Rec = Record<string, Untyped>;

export function fakeLlm(responses: unknown): {
  calls: Array<{ messages: Array<Rec>; options: Rec }>;
  complete: (messages: Array<Rec>, options: Rec) => Promise<Rec>;
} {
  let call = 0;
  const calls: Array<{ messages: Array<Rec>; options: Rec }> = [];
  return {
    calls,
    complete: (messages, options) => {
      calls.push({ messages, options });
      const response = Array.isArray(responses) ? (responses[call] as unknown) : responses;
      call += 1;
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(response as Rec);
    },
  };
}

export const SUCCESSFUL_DOWNLOAD = { dataUrl: 'data:image/webp;base64,ZmFrZQ==', bytes: 4, contentType: 'image/webp' };

/** A fake createImageFetcher()-shaped dependency. `result` may be `null` (every download fails), a fixed
 * success object, or a function `(url, options) => result|null` for per-call behaviour. */
export function fakeImageFetcher(
  result: Rec | null | ((url: string, options: Rec) => Rec | null) = SUCCESSFUL_DOWNLOAD
): {
  calls: Array<{ url: string; options: Rec }>;
  fetchAsDataUrl: (url: string, options: Rec) => Promise<Rec | null>;
} {
  const calls: Array<{ url: string; options: Rec }> = [];
  return {
    calls,
    fetchAsDataUrl: (url, options) => {
      calls.push({ url, options });
      return Promise.resolve(typeof result === 'function' ? result(url, options) : result);
    },
  };
}

export function fakeState(data: Rec = {}): { data: Rec; markDirty: () => void; readonly dirtyCount: number } {
  let dirty = 0;
  return {
    data,
    markDirty() {
      dirty += 1;
    },
    get dirtyCount() {
      return dirty;
    },
  };
}

export const CLIP_DATA_URL = 'data:video/mp4;base64,Y2xpcA==';

/** A fake createVideoFetcher()-shaped dependency; every method records its call and returns the given result. */
export function fakeVideoFetcher({
  attachment = { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 12, bytes: 4 },
  probe = { ok: true, durationSec: 30, title: 'Ελληνικό' },
  clip = { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 60, bytes: 4 },
  youtube = { ok: false, reason: 'download' },
}: { attachment?: Rec; probe?: Rec; clip?: Rec; youtube?: Rec } = {}): {
  calls: Array<{ fn: string; url: string; options: Rec }>;
  fetchAttachment: (url: string, options: Rec) => Promise<Rec>;
  probeSite: (url: string, options: Rec) => Promise<Rec>;
  fetchSiteClip: (url: string, options: Rec) => Promise<Rec>;
  probeYoutube: (url: string, options: Rec) => Promise<Rec>;
} {
  const calls: Array<{ fn: string; url: string; options: Rec }> = [];
  const answer = (fn: string, value: Rec) => (url: string, options: Rec) => {
    calls.push({ fn, url, options });
    return Promise.resolve(value);
  };
  return {
    calls,
    fetchAttachment: answer('fetchAttachment', attachment),
    probeSite: answer('probeSite', probe),
    fetchSiteClip: answer('fetchSiteClip', clip),
    probeYoutube: answer('probeYoutube', youtube),
  };
}
