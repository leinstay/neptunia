// Two interfaces connected to one core at once, as units: the same native conversation, member and community ids on
// both, and several communities on one. Nothing calls a provider: the model is a function that answers every request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../src/core.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { start as startFake } from '../src/interface/fake-interface.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { connectSocket } from '../src/protocol/wire.ts';
import { deliver, channelInfo, until } from './fixtures/core-over-fake.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ANSWER = 'γεια σου';
const SELF = { id: 'self-id', name: 'Nova' };

type Running = Awaited<ReturnType<typeof startFake>>;

async function withTwoInterfaces(
  body: (rig: { fake: Running; other: Running; requests: Array<unknown>; dataDir: string }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ti-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({
      bot: { timezone: 'UTC', owners: ['u1'], placeId: 'g1' },
      private: { enabled: true, minAffinity: 0 },
      models: { base: { video: false } },
      interfaces: { mode: 'units', drainMs: 2000 },
      pace: { settleMs: 0, settleMaxMs: 0 },
      typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
      gifs: { backfillMessages: 0 },
    })
  );
  createKeyStore({ privateDir: dataDir }).addCore({ name: 'core-1', value: 'test-key' });
  for (const name of ['fake', 'other']) {
    const made = spawnSync(
      process.execPath,
      ['scripts/client-token.ts', 'add', name, '--kind', 'interface', '--iface', name],
      { cwd: REPO, env: { PATH: process.env.PATH, NEPTUNIA_DATA_DIR: dataDir }, encoding: 'utf8' }
    );
    assert.equal(made.status, 0, made.stderr);
  }
  const requests: Array<unknown> = [];
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
  const connect = async (name: string, communities: ReadonlyArray<{ id: string; name: string }>) => {
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
      { adapter: createFakeAdapter({ iface: name, selfId: SELF.id }), self: SELF, communities }
    );
    started.push(running);
    return running;
  };
  try {
    const fake = await connect('fake', [
      { id: 'g1', name: 'Alpha' },
      { id: 'g2', name: 'Beta' },
    ]);
    const other = await connect('other', [{ id: 'g3', name: 'Gamma' }]);
    await body({ fake, other, requests, dataDir });
  } finally {
    for (const running of started) await running.stop();
    await core.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

test('each message is answered on its own interface and community when their native ids collide', async () => {
  // Bug: every effect goes to the first interface that connected, or a second interface's events are dropped.
  await withCapturedLogs(async () => {
    await withTwoInterfaces(async ({ fake, other, dataDir }) => {
      fake.adapter.seedConversation(channelInfo('c1'));
      fake.adapter.seedConversation({ ...channelInfo('c2'), rootId: 'g2' });
      other.adapter.seedConversation({ ...channelInfo('c1'), rootId: 'g3', iface: 'other' });
      const postedIn = (running: Running, conversation: string) =>
        running.adapter.messagesIn(conversation).filter((message) => message.authorId === SELF.id);

      const onOther = deliver(other.adapter, { id: 'm1', text: 'Nova, hello', at: Date.now(), mention: true });
      await other.emit({ ...onOther, iface: 'other', conversation: { ...onOther.conversation, rootId: 'g3' } });
      await until(() => postedIn(other, 'c1').length > 0);
      assert.equal(postedIn(fake, 'c1').length, 0);

      const inSecond = deliver(fake.adapter, {
        conversationId: 'c2',
        id: 'm1',
        text: 'Nova, hello',
        at: Date.now(),
        mention: true,
      });
      await fake.emit({ ...inSecond, conversation: { ...inSecond.conversation, rootId: 'g2' } });
      await until(() => postedIn(fake, 'c2').length > 0);
      assert.deepEqual(
        postedIn(fake, 'c2').map((message) => message.text),
        [ANSWER]
      );
      assert.equal(postedIn(other, 'c2').length, 0);

      // The two messages share native ids, and each is kept under its own interface.
      const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
      try {
        const rows = (handle.db as { prepare(sql: string): { all(): Array<{ iface: string }> } })
          .prepare(`SELECT DISTINCT iface FROM sources WHERE kind = 'seen' ORDER BY iface`)
          .all();
        assert.deepEqual(
          rows.map((row) => row.iface),
          ['fake', 'other']
        );
      } finally {
        handle.close();
      }
    });
  });
});

test('a read of a community goes to the interface that serves it', async () => {
  // Bug: a member or emoji read of the second interface's community is asked of the first and answers nothing.
  await withCapturedLogs(async () => {
    await withTwoInterfaces(async ({ fake, other }) => {
      other.adapter.seedConversation({ ...channelInfo('c1'), rootId: 'g3', iface: 'other' });
      const event = deliver(other.adapter, { id: 'm1', text: 'Nova, hello', at: Date.now(), mention: true });
      await other.emit({ ...event, iface: 'other', conversation: { ...event.conversation, rootId: 'g3' } });
      await until(() => other.adapter.messagesIn('c1').some((message) => message.authorId === SELF.id));
      const communityReads = (running: Running) =>
        running.adapter.calls.filter(
          (call) => call.args[0] === 'g3' || (call.args[0] as { rootId?: string })?.rootId === 'g3'
        );
      assert.notEqual(communityReads(other).length, 0);
      assert.equal(communityReads(fake).length, 0);
    });
  });
});

test('a DM on the second interface is answered there and kept in that account own DM scope', async () => {
  // Bug: the turn's memory context names the home interface, so the DM lands in a person nobody can read it back as.
  await withCapturedLogs(async () => {
    await withTwoInterfaces(async ({ other, dataDir }) => {
      other.adapter.seedConversation({ ...channelInfo('c1'), rootId: 'g3', iface: 'other' });
      other.adapter.seedMember('g3', { id: 'u1', name: 'Eleni' } as Parameters<Running['adapter']['seedMember']>[1]);
      const first = deliver(other.adapter, { id: 'm1', text: 'Nova, hello', at: Date.now(), mention: true });
      await other.emit({ ...first, iface: 'other', conversation: { ...first.conversation, rootId: 'g3' } });
      await until(() => other.adapter.messagesIn('c1').some((message) => message.authorId === SELF.id));

      other.adapter.seedConversation({
        ...channelInfo('d1'),
        kind: 'dm',
        rootId: null,
        partnerId: 'u1',
        iface: 'other',
      });
      const direct = deliver(other.adapter, { conversationId: 'd1', id: 'm2', text: 'hello', at: Date.now() });
      await other.emit({
        ...direct,
        iface: 'other',
        conversation: { id: 'd1', kind: 'dm', rootId: null, partnerId: 'u1', name: 'Eleni' },
      });
      await until(() => other.adapter.messagesIn('d1').some((message) => message.authorId === SELF.id));
      const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
      try {
        const rows = (handle.db as { prepare(sql: string): { all(): Array<{ audience_id: string }> } })
          .prepare(`SELECT DISTINCT audience_id FROM sources WHERE scope_kind = 'dm'`)
          .all();
        assert.deepEqual(
          rows.map((row) => row.audience_id),
          ['aud:dm:other:dm:u1']
        );
      } finally {
        handle.close();
      }
    });
  });
});
