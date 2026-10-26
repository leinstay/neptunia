// The core over the fake interface and nothing else: `startCore` (src/core.js) with the fake interface of
// src/interface/fake-interface.ts started without a `legacy` object, a scripted model and temporary data and private
// folders. A test seeds the fake's conversations and messages through `seed`, emits whole `message.received` events
// the way an interface delivers them, and reads what the persona posted, what the model was asked and which reads
// reached the fake (`fake.calls`). No Discord object exists anywhere in it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../../src/core.js';
import { start } from '../../src/interface/fake-interface.ts';
import { openMemoryDb } from '../../src/memory/db/open.js';
import type { ConversationInfo, MessageEvent } from '../../src/protocol/adapter.ts';
import { withCapturedLogs } from './capture-logs.js';

type Running = Awaited<ReturnType<typeof start>>;
export type Fake = Running['adapter'];
export type Row = Record<string, unknown>;
type Settings = Record<string, unknown>;

const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const SELF = { id: 'self-id', name: 'Nova' };
export const COMMUNITY = { id: 'g1', name: 'Alpha' };
export const ANSWER = 'γεια σου, καλημέρα';

/** The private layer of every rig: the settle wait, typing, and every optional behaviour off. */
const BASE_CONFIG: Settings = {
  bot: { timezone: 'UTC', owners: [], guildId: 'g1' },
  pace: { settleMs: 0, settleMaxMs: 0 },
  typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
  features: {
    typingSimulation: false,
    spontaneous: false,
    eavesdrop: false,
    followUp: false,
    participation: false,
    customEmoji: false,
    gifs: true,
    offlineCatchUp: false,
    diary: false,
    mediaDescriptions: false,
    missedAnswers: false,
    channelRoute: false,
    recall: false,
    memoryPrefetch: false,
    channelPull: false,
    elsewhere: false,
    speech: false,
    pauseNotice: false,
  },
};

const isRecord = (value: unknown): value is Settings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function merged(base: Settings, extra: Settings): Settings {
  const out: Settings = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const old = out[key];
    out[key] = isRecord(old) && isRecord(value) ? merged(old, value) : value;
  }
  return out;
}

export async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** Lets anything the core would still do on its own happen, so a test can assert that nothing did. */
export const settle = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));


type CoreOptions = Parameters<typeof startCore>[0];

// A core that fails to start leaves its watchers running, and the test process would never end. The failure is
// rethrown for the test, and the process ends shortly after, so a broken core fails the run instead of hanging it.
async function startCoreOrExit(options: CoreOptions): ReturnType<typeof startCore> {
  try {
    return await startCore(options);
  } catch (error) {
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 2000).unref();
    throw error;
  }
}

export type CoreRig = {
  fake: Fake;
  /** The requests the model got, as the messages array of each. */
  requests: Array<unknown>;
  /** Emits an event over the link and resolves with the core's ack status. */
  emit(event: unknown): Promise<string>;
  /** What the persona posted in a conversation, in order. */
  posted(conversationId: string): Array<string>;
  /** The text of request `index`, as one string. */
  requestText(index: number): string;
  /** The rows of the memory database's `sources` table of one kind, read through a second read-only connection. */
  sources(kind: string): Array<Row>;
};

export type RigOptions = {
  /** Settings of the private layer, merged over the base. */
  config?: Settings;
  /** The reads the fake offers (wire names); all when absent. */
  reads?: ReadonlyArray<string>;
  /** Seeds the fake once the core is up, before the body runs. */
  seed?: (fake: Fake) => void;
  /** What the scripted model answers; `<msg>` plus the default answer when absent. */
  answer?: string;
};

export async function withFakeCore<T>(
  options: RigOptions,
  body: (rig: CoreRig) => Promise<T>
): Promise<{ result: T; logs: Array<Row> }> {
  // Short folders: a Unix socket path is limited to 108 bytes.
  const root = mkdtempSync(join(tmpdir(), 'cf-'));
  const dataDir = join(root, 'd');
  const privateDir = join(root, 'p');
  mkdirSync(privateDir);
  writeFileSync(join(privateDir, 'config.local.json'), JSON.stringify(merged(BASE_CONFIG, options.config ?? {})));
  const requests: Array<unknown> = [];
  const llm = {
    complete: (messages: unknown): Promise<{ text: string; usage: object; estimated: number }> => {
      requests.push(messages);
      return Promise.resolve({ text: options.answer ?? `<msg>${ANSWER}</msg>`, usage: {}, estimated: 10 });
    },
  };
  let running: Running | null = null;
  const captured = await withCapturedLogs(async () => {
    const core = await startCoreOrExit({
      paths: { rootDir: REPO, privateDir, dataDir },
      env: { OPENROUTER_CORE_KEY: 'test-key' },
      interfaces: [
        {
          name: 'fake',
          start: async (host) => {
            running = await start(host, {
              self: SELF,
              community: COMMUNITY,
              ...(options.reads === undefined ? {} : { reads: options.reads }),
            });
            return running;
          },
        },
      ],
      llm,
      embedder: { embed: () => Promise.resolve([]) },
    });
    if (running === null) throw new Error('the core never started the fake interface');
    const live: Running = running;
    options.seed?.(live.adapter);
    const dbPath = join(dataDir, 'memory.db');
    const rig: CoreRig = {
      fake: live.adapter,
      requests,
      emit: (event) => live.emit(event),
      posted: (conversationId) =>
        live.adapter
          .messagesIn(conversationId)
          .filter((message) => message.authorId === SELF.id)
          .map((message) => message.text),
      requestText: (index) => JSON.stringify(requests[index]),
      sources: (kind) => {
        const handle = openMemoryDb(dbPath, { readOnly: true });
        try {
          const sql = 'SELECT kind, native_id, owner_file, text FROM sources WHERE kind = ? ORDER BY rowid';
          return (handle.db as { prepare(sql: string): { all(kind: string): Array<Row> } })
            .prepare(sql)
            .all(kind)
            .map((row) => ({ ...row }));
        } finally {
          handle.close();
        }
      },
    };
    try {
      return await body(rig);
    } finally {
      await core.stop();
    }
  }).finally(() => rmSync(root, { recursive: true, force: true }));
  return { result: captured.result, logs: captured.logs as Array<Row> };
}

/** A server channel as the fake reports it: readable, writable, public, quiet. */
export function channelInfo(id: string, extra: Partial<ConversationInfo> = {}): ConversationInfo {
  return {
    id,
    kind: 'channel',
    communityId: COMMUNITY.id,
    name: `room-${id}`,
    topic: null,
    category: null,
    iface: 'fake',
    permissions: { read: true, send: true, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience: {
      everyone: true,
      groups: [],
      groupAllow: [],
      groupDeny: [],
      memberAllow: [],
      memberDeny: [],
      memberGroups: {},
    },
    ...extra,
  };
}

export type LineOptions = {
  id: string;
  conversationId?: string;
  text: string;
  at: number;
  authorId?: string;
  authorName?: string;
  /** Names the persona (the message is a call to her). */
  mention?: boolean;
  system?: boolean;
  reactions?: Array<{ emoji: string; count: number; mine: boolean }>;
};

/** A `message.received` event of a member's message in a server channel, as an interface delivers it. */
export function lineEvent(options: LineOptions): MessageEvent {
  const authorId = options.authorId ?? 'u1';
  const self = authorId === SELF.id;
  return {
    kind: 'message.received',
    iface: 'fake',
    at: options.at,
    id: `fake:message:${options.id}`,
    conversation: {
      id: options.conversationId ?? 'c1',
      kind: 'channel',
      communityId: COMMUNITY.id,
      name: `room-${options.conversationId ?? 'c1'}`,
    },
    message: {
      id: options.id,
      author: { id: authorId, name: options.authorName ?? 'Eleni', self, bot: false },
      content: options.text,
      sourceText: options.text,
      system: options.system ?? false,
      at: options.at,
      replyToId: null,
      replyPingUserId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: options.reactions ?? [],
    },
    addressing: {
      mentioned: options.mention === true,
      replyToSelf: false,
      mentionedUserIds: options.mention === true ? [SELF.id] : [],
      mentionedConversationIds: [],
    },
  };
}

/** Seeds the line into the fake's history and returns it, ready to emit. */
export function deliver(fake: Fake, options: LineOptions): MessageEvent {
  const event = lineEvent(options);
  fake.seedEvent(event);
  return event;
}
