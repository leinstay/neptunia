// The fakes of tests/describe.test.ts: the model, the two fetchers and the state the describer is given. Each records
// what it was asked and answers what the test set.
import type { Untyped } from '../../src/tools/types.ts';

export function fakeLlm(responses: Untyped): {
  calls: Array<{ messages: Untyped; options: Untyped }>;
  complete: (messages: Untyped, options: Untyped) => Promise<Untyped>;
} {
  let call = 0;
  const calls: Array<{ messages: Untyped; options: Untyped }> = [];
  return {
    calls,
    complete: async (messages: Untyped, options: Untyped) => {
      calls.push({ messages, options });
      const response = Array.isArray(responses) ? responses[call] : responses;
      call += 1;
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

export const SUCCESSFUL_DOWNLOAD = { dataUrl: 'data:image/webp;base64,ZmFrZQ==', bytes: 4, contentType: 'image/webp' };

/** A fake createImageFetcher()-shaped dependency. `result` may be `null` (every download fails), a fixed
 * success object, or a function `(url, options) => result|null` for per-call behaviour. */
export function fakeImageFetcher(result: Untyped = SUCCESSFUL_DOWNLOAD): {
  calls: Array<Untyped>;
  fetchAsDataUrl: (url: string, options: Untyped) => Promise<Untyped>;
} {
  const calls: Array<Untyped> = [];
  return {
    calls,
    fetchAsDataUrl: async (url: string, options: Untyped) => {
      calls.push({ url, options });
      return typeof result === 'function' ? result(url, options) : result;
    },
  };
}

export function fakeState(data = {}): { data: Untyped; markDirty: () => void; readonly dirtyCount: number } {
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
}: { attachment?: Untyped; probe?: Untyped; clip?: Untyped; youtube?: Untyped } = {}): {
  calls: Array<{ fn: string; url: string; options: Untyped }>;
  fetchAttachment: (url: string, options: Untyped) => Promise<Untyped>;
  probeSite: (url: string, options: Untyped) => Promise<Untyped>;
  fetchSiteClip: (url: string, options: Untyped) => Promise<Untyped>;
  probeYoutube: (url: string, options: Untyped) => Promise<Untyped>;
} {
  const calls: Array<{ fn: string; url: string; options: Untyped }> = [];
  return {
    calls,
    fetchAttachment: async (url: string, options: Untyped) => {
      calls.push({ fn: 'fetchAttachment', url, options });
      return attachment;
    },
    probeSite: async (url: string, options: Untyped) => {
      calls.push({ fn: 'probeSite', url, options });
      return probe;
    },
    fetchSiteClip: async (url: string, options: Untyped) => {
      calls.push({ fn: 'fetchSiteClip', url, options });
      return clip;
    },
    probeYoutube: async (url: string, options: Untyped) => {
      calls.push({ fn: 'probeYoutube', url, options });
      return youtube;
    },
  };
}
