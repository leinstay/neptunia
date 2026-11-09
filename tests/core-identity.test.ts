// Who the persona is and which interface a row belongs to, end to end (the harness of tests/core-slice.test.ts):
// `startCore` over the fake interface, whose `hello` names the persona and the root. The persona's name in every
// request is the one of `hello`, a nickname change that arrives as `membership.changed` changes it for the next
// request, and the rows her turn writes carry the interface of the event, not a fixed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../src/core.ts';
import { start } from '../src/interface/fake-interface.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { channelInfo, deliver } from './fixtures/core-over-fake.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { chainsOf } from './fixtures/chains.ts';

type Running = Awaited<ReturnType<typeof start>>;
type Row = Record<string, unknown>;
type MemberMessage = { id: string; content: string; at: number };

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SELF_ID = 'self-id';
const SELF_NAME = 'Nova';
const ANSWER = 'γεια σου, καλημέρα';
const PRIVATE_CONFIG = {
  bot: { timezone: 'UTC', owners: [], placeId: 'g1' },
  // No video role, so the start sends no canary probe to YouTube.
  models: { routes: chainsOf({ video: false }) },
  pace: { settleMs: 0, settleMaxMs: 0 },
  typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
  features: {
    typingSimulation: false,
    spontaneous: false,
    eavesdrop: false,
    followUp: false,
    participation: false,
    customEmoji: false,
    gifs: false,
    offlineCatchUp: false,
    selfreflection: false,
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

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Short folders: a Unix socket path is limited to 108 bytes.
function folders() {
  const root = mkdtempSync(join(tmpdir(), 'cs-'));
  const dataDir = join(root, 'd');
  // Runtime privateDir aliases the prepared persona data root.
  const privateDir = dataDir;
  mkdirSync(join(privateDir, 'config'), { recursive: true });
  writeFileSync(join(privateDir, 'config', 'config.json'), JSON.stringify(PRIVATE_CONFIG));
  return { root, dataDir, privateDir, paths: { rootDir: REPO, privateDir, dataDir } };
}

// The scripted model: it answers every request with `<msg>` + ANSWER and keeps the requests it got.
function scriptedLlm() {
  const requests: Array<unknown> = [];
  return {
    requests,
    // Plan 2026-11-04-cli-and-memory B1: the door asks the address classifier first; it says yes and is not recorded.
    complete: (messages: unknown, given?: unknown): Promise<{ text: string; usage: object; estimated: number }> => {
      if ((given as { purpose?: unknown } | undefined)?.purpose === 'address')
        return Promise.resolve({ text: 'yes', usage: {}, estimated: 1 });
      requests.push(messages);
      return Promise.resolve({ text: `<msg>${ANSWER}</msg>`, usage: {}, estimated: 10 });
    },
  };
}

async function withIdentityCore(body: (ctx: Context) => Promise<void>) {
  const dirs = folders();
  const llm = scriptedLlm();
  let running: Running | null = null;
  const core = await startCore({
    paths: dirs.paths,
    env: { OPENROUTER_CORE_KEY: 'test-key' },
    interfaces: [
      {
        name: 'fake',
        start: async (host) => {
          running = await start(host, {
            self: { id: SELF_ID, name: SELF_NAME },
            root: { id: 'g1', name: 'Alpha' },
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
  const dbPath = join(dirs.dataDir, 'memory.db');
  live.adapter.seedChat(channelInfo('c1'));
  const ctx: Context = {
    ...dirs,
    dbPath,
    llm,
    mentionEvent: (message) =>
      deliver(live.adapter, { id: message.id, text: message.content, at: message.at, mention: true }),
    emit: (event) => live.emit(event),
    posted: () =>
      live.adapter
        .messagesIn('c1')
        .filter((message) => message.authorId === SELF_ID)
        .map((message) => message.text),
    rows: (kind) => {
      const handle = openMemoryDb(dbPath, { readOnly: true });
      try {
        const sql = 'SELECT id, iface, kind, native_id FROM sources WHERE kind = ? ORDER BY rowid';
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
    await body(ctx);
  } finally {
    await core.stop();
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

type Context = ReturnType<typeof folders> & {
  dbPath: string;
  llm: ReturnType<typeof scriptedLlm>;
  mentionEvent(message: MemberMessage): unknown;
  emit(event: unknown): Promise<string>;
  posted(): Array<string>;
  rows(kind: string): Array<Row>;
};

const requestText = (ctx: Context, index: number): string => JSON.stringify(ctx.llm.requests[index]);

function nicknameChange(accountId: string, name: string, n: number): Row {
  return {
    kind: 'membership.changed',
    iface: 'fake',
    at: Date.now(),
    id: `fake:membership:g1:${accountId}:updated:${n}`,
    placeId: 'g1',
    accountId,
    change: 'updated',
    member: { id: accountId, name, bot: accountId === SELF_ID },
  };
}

test('a nickname change of the persona reaches the next request', async () => {
  await withCapturedLogs(() =>
    withIdentityCore(async (ctx) => {
      await ctx.emit(ctx.mentionEvent({ id: 'm1', content: 'hello', at: Date.now() }));
      await until(() => ctx.posted().length === 1);
      assert.equal(await ctx.emit(nicknameChange(SELF_ID, 'Nova2', 1)), 'ok');
      await ctx.emit(ctx.mentionEvent({ id: 'm2', content: 'and now', at: Date.now() }));
      await until(() => ctx.posted().length === 2);
      assert.ok(requestText(ctx, 1).includes('You are Nova2, '), 'the new nickname');
      assert.equal(requestText(ctx, 1).includes(`You are ${SELF_NAME}, `), false, 'not the old one');
    })
  );
});

test('the rows of her turn carry the interface of the event, not a fixed one', async () => {
  await withCapturedLogs(() =>
    withIdentityCore(async (ctx) => {
      await ctx.emit(ctx.mentionEvent({ id: 'm1', content: 'hello', at: Date.now() }));
      // The answer row is written at the turn's end, after the said row: wait for both before reading them.
      await until(() => ctx.posted().length === 1 && ctx.rows('said').length === 1 && ctx.rows('answer').length === 1);
      const [said] = ctx.rows('said');
      assert.equal(said?.iface, 'fake');
      // Her line adopts the observed row of its message family, whose id is the family's, so the interface is the fact here.
      assert.equal(ctx.rows('said').length, 1);
      assert.deepEqual(
        ctx.rows('answer').map((row) => row.iface),
        ['fake']
      );
    })
  );
});
