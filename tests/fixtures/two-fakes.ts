// One core in the test process with its interfaces as units, and any number of fake interfaces connected in the order
// a test chooses, each with the roots it names (none at all when the list is empty). Temporary folders, a scripted
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
import type { ChatInfo, MemberInfo, MessageEvent } from '../../src/protocol/adapter.ts';
import { connectSocket } from '../../src/protocol/wire.ts';
import { withCapturedLogs } from './capture-logs.ts';
import { addAccount, addPerson } from './memory-db/opaque-people.ts';
import type { Db } from '../../src/memory/db/types.ts';
import { OWNER_PERSON } from './owner-accounts.ts';
import { channelInfo, lineEvent } from './core-over-fake.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const ANSWER = 'γεια σου';
export const SELF = { id: 'self-id', name: 'Nova' };

export type Running = Awaited<ReturnType<typeof startFake>>;
export type Named = { id: string; name: string };
/** What an interface says of itself in `hello.names`: its name, its nouns per kind of place, its word for a direct chat. */
export type InterfaceNames = { interface: string; nouns: Record<string, string>; dm: string };
export type Rig = {
  connect: (name: string, roots: ReadonlyArray<Named>, names?: InterfaceNames) => Promise<Running>;
  requests: Array<unknown>;
  dataDir: string;
  /** `sql` over the memory database, through a read-only connection. */
  rows: (sql: string) => Array<Record<string, unknown>>;
};

/**
 * The owner's meta-person with each of `owners` bound to it on every interface of `names`, written before the core
 * opens the database, as pairing or `/memory bind` would have left it.
 */
function seedOwner(file: string, names: ReadonlyArray<string>, owners: ReadonlyArray<string>): void {
  const handle = openMemoryDb(file);
  try {
    const db = handle.db as Db;
    addPerson(db, OWNER_PERSON);
    db.prepare('UPDATE people SET meta = 1 WHERE id = ?').run(OWNER_PERSON);
    for (const iface of names)
      for (const native of owners) {
        const id = `account:${iface}:${native}`;
        addAccount(db, { id, iface, authority: `${iface}/global`, native, person: OWNER_PERSON });
        db.prepare(
          'INSERT INTO person_accounts (id, person_id, iface, platform_id, recorded_at) VALUES (?, ?, ?, ?, ?)'
        ).run(id, OWNER_PERSON, iface, native, '2026-01-01T00:00:00.000Z');
      }
  } finally {
    handle.close();
  }
}

export async function withFakes(
  settings: { owners?: ReadonlyArray<string>; ownerPerson?: string; names: ReadonlyArray<string> },
  body: (rig: Rig) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'tf-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  // The owner: `ownerPerson` names one a test seeds itself, else `owners` are bound to the rig's own owner person.
  const owners = settings.owners ?? [];
  if (owners.length > 0) seedOwner(join(dataDir, 'memory.db'), settings.names, owners);
  const ownerPerson = settings.ownerPerson ?? (owners.length > 0 ? OWNER_PERSON : null);
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({
      bot: { timezone: 'UTC', ...(ownerPerson === null ? {} : { ownerPerson }) },
      dm: { enabled: true }, private: { minAffinity: 0 },
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
    const connect = async (
      name: string,
      roots: ReadonlyArray<Named>,
      names?: InterfaceNames
    ): Promise<Running> => {
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
          roots,
          root: roots[0] ?? null,
          ...(names === undefined ? {} : { names }),
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

/** What the persona posted in a chat of this interface. */
export const postedIn = (running: Running, chat: string): Array<unknown> =>
  running.adapter
    .messagesIn(chat)
    .filter((message) => message.authorId === SELF.id)
    .map((message) => message.text);

/** Every read of this interface that named root `id`, by method. */
export const readsOf = (running: Running, id: string): Array<string> =>
  running.adapter.calls
    .filter((call) => call.args[0] === id || (call.args[0] as { placeId?: unknown } | null)?.placeId === id)
    .map((call) => call.op);

export function seedRoom(running: Running, chat: string, placeId: string): void {
  running.adapter.seedChat(channelInfo(chat, { rootId: placeId, iface: running.iface }));
}

export function seedDm(running: Running, chat: string, partner: string): void {
  const info: ChatInfo = channelInfo(chat, {
    kind: 'dm',
    rootId: null,
    partnerId: partner,
    iface: running.iface,
  });
  running.adapter.seedChat(info);
}

export function seedPerson(running: Running, placeId: string, id: string, name: string): void {
  const member: MemberInfo = {
    id,
    name,
    bot: false,
    groupIds: [],
    avatar: { hash: null, url: null, largeUrl: null },
  };
  running.adapter.seedMember(placeId, member);
}

/** A mention of the persona in a room of this interface, seeded into its history and emitted. */
export async function mentionIn(
  running: Running,
  chat: string,
  placeId: string,
  id: string
): Promise<void> {
  const line = lineEvent({ chatId: chat, id, text: 'Nova, hello', at: Date.now(), mention: true });
  const event: MessageEvent = {
    ...line,
    iface: running.iface,
    id: `${running.iface}:message:${id}`,
    chat: { ...line.chat, rootId: placeId },
  };
  running.adapter.seedEvent(event);
  assert.equal(await running.emit(event), 'ok');
}

/** A direct message of `author` to the persona on this interface, seeded into its history and emitted. */
export async function directIn(running: Running, chat: string, author: string, id: string): Promise<void> {
  const line = lineEvent({ chatId: chat, id, text: 'hello', at: Date.now(), authorId: author });
  const event: MessageEvent = {
    ...line,
    iface: running.iface,
    id: `${running.iface}:message:${id}`,
    chat: { id: chat, kind: 'dm', rootId: null, partnerId: author, name: 'Eleni' },
  };
  running.adapter.seedEvent(event);
  assert.equal(await running.emit(event), 'ok');
}
