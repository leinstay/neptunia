// The first step of a selfreflection post on its own (src/turn/selfreflection.ts#createSelfreflection), over fakes: a
// store that holds only the given past posts, a planner model that answers a scripted plan or fails, and memory off,
// so the plan request carries the kinds, the seeds and the history and nothing else. The tests of the drawn kind
// (tests/selfreflection-draw*.test.ts) read what the plan request offered in `<kinds>`, the plan that came back and
// the `selfreflection: planned` journal line. Synthetic data only.
import { createSelfreflection } from '../../src/turn/selfreflection.ts';
import type { SelfreflectionPrepared } from '../../src/turn/selfreflection.ts';
import type { ConversationInfo } from '../../src/protocol/adapter.ts';
import { NO_OP } from '../../src/turn/journal.ts';
import { withCapturedLogs } from './capture-logs.ts';
import type { LogEntry } from './capture-logs.ts';
import { labels } from './labels.ts';

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

/** The diary's conversation: a channel of no community where she may attach files. */
const CHANNEL: ConversationInfo = {
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
  posts?: Array<PastPost>;
  /** The planner's answer; ignored when `failing`. */
  answer?: Record<string, unknown>;
  /** Whether the plan request throws, as a provider error does. */
  failing?: boolean;
  /** Whether the post may carry a picture: an image client and Attach Files. */
  pictures?: boolean;
  /** The kind the owner's command forced, or null for none. */
  forcedKind?: string | null;
};

export type PrepareRun = {
  /** The plan the step returned. */
  plan: SelfreflectionPrepared['plan'];
  /** The kind keys the plan request's `<kinds>` block offered, in its order; [] when no plan request went out. */
  offered: Array<string>;
  /** The `selfreflection: planned` journal line. */
  planned: LogEntry | undefined;
};

/** The kind keys of the `<kinds>` block in a request's texts: each line that starts with a key and ` weight `. */
function kindsOffered(messages: ReadonlyArray<{ content: string }>): Array<string> {
  const text = messages.map((message) => message.content).join('\n');
  const start = text.indexOf('<kinds>');
  const end = text.indexOf('</kinds>');
  if (start < 0 || end < start) return [];
  return text
    .slice(start, end)
    .split('\n')
    .flatMap((line) => {
      const found = /^(\S+) weight /.exec(line.trim());
      return found?.[1] === undefined ? [] : [found[1]];
    });
}

/** One run of prepareSelfreflection over the fakes. */
export async function prepare({
  rng,
  posts = [],
  answer = { kind: 'news', brief: 'a planned scene', search: '', picture: false, seed: 1 },
  failing = false,
  pictures = false,
  forcedKind = null,
}: PrepareOptions): Promise<PrepareRun> {
  const requests: Array<Array<{ content: string }>> = [];
  const selfreflection = createSelfreflection({
    hot: {
      prompts: {
        'selfreflection-planner': 'PLAN for {{name}}',
        'selfreflection-seeds': '# place\na pier\na roof\n# light\nfog\nrain',
        labels,
      },
    },
    store: {
      getSelfreflection: () => ({ posts }),
      getPlace: () => null,
      listChannels: () => [],
      getLore: () => [],
      topPlaces: () => [],
      listUserProfiles: () => [],
      getUser: () => null,
      state: { data: {} },
    },
    llm: {
      complete: (messages) => {
        requests.push(structuredClone(messages));
        if (failing) return Promise.reject(new Error('the provider answered 502'));
        return Promise.resolve({ text: JSON.stringify(answer), usage: {}, estimated: 5 });
      },
    },
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    rng,
    lookup: null,
    images: pictures ? { quota: () => null } : null,
    journalOp: () => NO_OP,
    recentOfPlaces: () => ({ lines: undefined, audience: undefined }),
  });
  const { result, logs } = await withCapturedLogs(() =>
    selfreflection.prepareSelfreflection({
      config: { bot: { timezone: 'UTC' }, llm: { maxRequestTokens: 50000 }, selfreflection: {} },
      channel: CHANNEL,
      selfName: 'Nia',
      history: [],
      now: NOW,
      params: forcedKind === null ? { forced: false } : { kind: forcedKind, forced: true },
      memoryOn: false,
    })
  );
  const [first] = requests;
  return {
    plan: result.plan,
    offered: first === undefined ? [] : kindsOffered(first),
    planned: logs.find((entry) => entry.msg === 'selfreflection: planned'),
  };
}
