// One core in the test process with its interfaces as units, and any number of fake interfaces connected in the order
// a test chooses, each with the communities it names (none at all when the list is empty). Temporary folders, a scripted
// model, no provider and no platform. The native ids of the interfaces may collide: that is what these tests are for.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../../src/core.ts';
import { createFakeAdapter } from '../../src/interface/fake.ts';
import { start as startFake } from '../../src/interface/fake-interface.ts';
import { createKeyStore } from '../../src/keys/store.ts';
import { openMemoryDb } from '../../src/memory/db/open.ts';
import type { ConversationInfo, MemberInfo, MessageEvent } from '../../src/protocol/adapter.ts';
import { connectSocket } from '../../src/protocol/wire.ts';
import { withCapturedLogs } from './capture-logs.ts';
import { channelInfo, lineEvent } from './core-over-fake.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const ANSWER = 'γεια σου';
export const SELF = { id: 'self-id', name: 'Nova' };

export type Running = Awaited<ReturnType<typeof startFake>>;
export type Named = { id: string; name: string };
export type Rig = {
  connect: (name: string, communities: ReadonlyArray<Named>) => Promise<Running>;
  requests: Array<unknown>;
  dataDir: string;
  /** `sql` over the memory database, through a read-only connection. */
  rows: (sql: string) => Array<Record<string, unknown>>;
};

export async function withFakes(
  settings: { owners?: ReadonlyArray<string>; names: ReadonlyArray<string> },
  body: (rig: Rig) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'tf-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({
      bot: {
        timezone: 'UTC',
        owners: settings.owners ?? [],

      },
      private: { enabled: true, minAffinity: 0 },
      models: { base: { video: false } },
      interfaces: { mode: 'units', drainMs: 2000 },
      pace: { settleMs: 0, settleMaxMs: 0 },
      typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
      gifs: { backfillMessages: 0 },
    })
  );
  createKeyStore({ privateDir: dataDir }).addCore({ name: 'core-1', value: 'test-key' });
  for (const name of settings.names) {
    const made = spawnSync(
      process.execPath,
      ['scripts/client-token.ts', 'add', name, '--kind', 'interface', '--iface', name],
      { cwd: REPO, env: { PATH: process.env.PATH, NEPTUNIA_DATA_DIR: dataDir }, encoding: 'utf8' }
    );
    assert.equal(made.status, 0, made.stderr);
  }
  const requests: Array<unknown> = [];
  await withCapturedLogs(async () => {
    const core = await startCore({
      paths: { rootDir: REPO, privateDir: dataDir, dataDir },
      env: {},
      interfaces: [],
      llm: {
        complete: (messages: unknown) => {
          requests.push(messages);
          return Promise.resolve({ text: `<msg>${ANSWER}</msg>`, usage: {}, estimated: 10 });
        },
      },
      embedder: { embed: () => Promise.resolve([]) },
    });
    const started: Array<Running> = [];
    const connect = async (name: string, communities: ReadonlyArray<Named>): Promise<Running> => {
      const log = { info() {}, warn() {}, error() {}, debug() {} };
      const running = await startFake(
        {
          connect: () => connectSocket({ path: join(dataDir, 'run', 'core.sock'), maxFrameBytes: 16 * 1024 * 1024 }),
          token: readFileSync(join(dataDir, 'clients', `${name}.token`), 'utf8').trim(),
          dataDir: join(dataDir, 'interfaces', name),
          env: {},
          config: () => ({}),
          onConfigChange: () => () => {},
          log,
        },
        {
          adapter: createFakeAdapter({ iface: name, selfId: SELF.id }),
          self: SELF,
          communities,
          community: communities[0] ?? null,
        }
      );
      started.push(running);
      return running;
    };
    const rows = (sql: string): Array<Record<string, unknown>> => {
      const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
      try {
        const db = handle.db as { prepare(text: string): { all(): Array<Record<string, unknown>> } };
        return db
          .prepare(sql)
          .all()
          .map((row) => ({ ...row }));
      } finally {
        handle.close();
      }
    };
    try {
      await body({ connect, requests, dataDir, rows });
    } finally {
      for (const running of started) await running.stop();
      await core.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

/** Waits for `check`; `what` names it in the failure. */
export async function waitFor(check: () => boolean, what: string, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** What the persona posted in a conversation of this interface. */
export const postedIn = (running: Running, conversation: string): Array<unknown> =>
  running.adapter
    .messagesIn(conversation)
    .filter((message) => message.authorId === SELF.id)
    .map((message) => message.text);

/** Every read of this interface that named community `id`, by method. */
export const readsOf = (running: Running, id: string): Array<string> =>
  running.adapter.calls
    .filter((call) => call.args[0] === id || (call.args[0] as { communityId?: unknown } | null)?.communityId === id)
    .map((call) => call.op);

export function seedRoom(running: Running, conversation: string, communityId: string): void {
  running.adapter.seedConversation(channelInfo(conversation, { communityId, iface: running.iface }));
}

export function seedDm(running: Running, conversation: string, partner: string): void {
  const info: ConversationInfo = channelInfo(conversation, {
    kind: 'dm',
    communityId: null,
    partnerId: partner,
    iface: running.iface,
  });
  running.adapter.seedConversation(info);
}

export function seedPerson(running: Running, communityId: string, id: string, name: string): void {
  const member: MemberInfo = {
    id,
    name,
    bot: false,
    groupIds: [],
    avatar: { hash: null, url: null, largeUrl: null },
  };
  running.adapter.seedMember(communityId, member);
}

/** A mention of the persona in a room of this interface, seeded into its history and emitted. */
export async function mentionIn(
  running: Running,
  conversation: string,
  communityId: string,
  id: string
): Promise<void> {
  const line = lineEvent({ conversationId: conversation, id, text: 'Nova, hello', at: Date.now(), mention: true });
  const event: MessageEvent = {
    ...line,
    iface: running.iface,
    id: `${running.iface}:message:${id}`,
    conversation: { ...line.conversation, communityId },
  };
  running.adapter.seedEvent(event);
  assert.equal(await running.emit(event), 'ok');
}

/** A direct message of `author` to the persona on this interface, seeded into its history and emitted. */
export async function directIn(running: Running, conversation: string, author: string, id: string): Promise<void> {
  const line = lineEvent({ conversationId: conversation, id, text: 'hello', at: Date.now(), authorId: author });
  const event: MessageEvent = {
    ...line,
    iface: running.iface,
    id: `${running.iface}:message:${id}`,
    conversation: { id: conversation, kind: 'dm', communityId: null, partnerId: author, name: 'Eleni' },
  };
  running.adapter.seedEvent(event);
  assert.equal(await running.emit(event), 'ok');
}
