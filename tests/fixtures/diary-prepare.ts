// The first step of a diary entry on its own (src/turn/diary.ts#createDiary), over fakes: a store that holds only the
// given past posts, a director that answers a scripted scene or fails, and memory off. The tests of the drawn kind
// (tests/diary-draw*.test.ts) read the kind that came back and the `diary: prepared` journal line, and the tests of the
// scenes read the director's requests and the scenes. Synthetic data only.
import { createDiary } from '../../src/turn/diary.ts';
import type { DiaryPrepared } from '../../src/turn/diary.ts';
import type { ChatInfo } from '../../src/protocol/adapter.ts';
import { withCapturedLogs } from './capture-logs.ts';
import type { LogEntry } from './capture-logs.ts';
import { labels } from './labels.ts';
import { sceneAnswerText } from './scene-answer.ts';

export const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

/** A seeded stream in [0, 1) (mulberry32), so a thousand draws are the same on every run. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A past post as the store keeps it. */
export type PastPost = { at: number; kind: string; gist: string; picture: null };

/** Past posts of the given kinds, oldest first, one hour apart and ending an hour before NOW. */
export function postsOf(kinds: ReadonlyArray<string>): Array<PastPost> {
  return kinds.map((kind, index) => ({
    at: NOW - (kinds.length - index) * HOUR,
    kind,
    gist: `an earlier ${kind} post`,
    picture: null,
  }));
}

/** The diary's chat: a channel of no root where she may attach files. */
const CHANNEL: ChatInfo = {
  id: 'd1',
  kind: 'channel',
  rootId: null,
  name: 'journal',
  iface: 'fake',
  permissions: { read: true, send: true, attach: true, react: true },
  owner: null,
  lastMessageAt: null,
  voice: false,
  public: true,
};

export type PrepareOptions = {
  rng: () => number;
  posts?: Array<PastPost | Record<string, unknown>>;
  /** The director's answer to a request's user text; the default builds on set 1 and keeps its first line. */
  answer?: (user: string) => string;
  /** Whether the director's request throws, as a provider error does. */
  failing?: boolean;
  /** Whether the entry may carry a picture: an image client and Attach Files. */
  pictures?: boolean;
  /** The kind the owner's command forced, or null for none. */
  forcedKind?: string | null;
  /** The seeds file the director draws from. */
  seeds?: string;
};

export type PrepareRun = {
  /** What the step returned. */
  result: DiaryPrepared;
  /** The kind the step chose. */
  kind: string | null;
  /** The user text of each director request, in the order sent. */
  requests: Array<string>;
  /** The `diary: prepared` journal line. */
  prepared: LogEntry | undefined;
  /** The `diary: skip` journal line. */
  skipped: LogEntry | undefined;
};

/** One run of prepareDiary over the fakes. */
export async function prepare({
  rng,
  posts = [],
  answer = (user) => sceneAnswerText(user),
  failing = false,
  pictures = false,
  forcedKind = null,
  seeds = '# place\na pier\na roof\na field\n# light\nfog\nrain\ndusk',
}: PrepareOptions): Promise<PrepareRun> {
  const requests: Array<string> = [];
  const config = { bot: { timezone: 'UTC' }, llm: { maxRequestTokens: 50000 }, diary: {} };
  const diary = createDiary({
    hot: { config, prompts: { 'diary-scene': 'SCENE_TASK', 'diary-seeds': seeds, labels } },
    store: {
      getDiary: () => ({ posts }),
      getPlace: () => null,
      listUserProfiles: () => [],
      state: { data: {} },
    },
    llm: {
      complete: (messages) => {
        const user = String(messages[1]?.content ?? '');
        requests.push(user);
        if (failing) return Promise.reject(new Error('the provider answered 502'));
        return Promise.resolve({ text: answer(user), usage: {} });
      },
    },
    rng,
    images: pictures ? { quota: () => null } : null,
  });
  const { result, logs } = await withCapturedLogs(() =>
    diary.prepareDiary({
      config,
      channel: CHANNEL,
      now: NOW,
      params: forcedKind === null ? { forced: false } : { kind: forcedKind, forced: true },
      memoryOn: false,
    })
  );
  return {
    result,
    kind: result.kind,
    requests,
    prepared: logs.find((entry) => entry.msg === 'diary: prepared'),
    skipped: logs.find((entry) => entry.msg === 'diary: skip'),
  };
}
