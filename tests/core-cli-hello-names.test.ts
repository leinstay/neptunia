// The names the command line declares in its hello (`hello.names`) reach the memory when the client connects over the
// core's socket as a principal of kind `cli`, the way `neptunia` does against a core whose interfaces run as units.
// `startCore` over temporary folders, the real `cli` interface package on a real socket and the memory database read
// through a second, read-only connection. Short folders: a Unix socket path is limited to 108 bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start as startCli } from '../interfaces/cli/link.ts';
import { startCore } from '../src/core.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { interfaceNamesOf } from '../src/memory/db/frame-reads.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { serveAdapter } from '../src/protocol/serve.ts';
import { connectSocket } from '../src/protocol/wire.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { chainsOf } from './fixtures/chains.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
/** What the hello of `interfaces/cli/link.ts` (`CLI_NAMES`) says, as the memory reads it back. */
const EXPECTED = { name: 'CLI', nouns: {}, dm: 'chat' };

type Rig = { dataDir: string; connect: () => ReturnType<typeof connectSocket>; token: string };

async function withCore(body: (rig: Rig) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ch-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({
      bot: { timezone: 'UTC', owners: [] },
      models: { routes: chainsOf({ video: false }) },
      interfaces: { mode: 'units', drainMs: 500 },
    })
  );
  createKeyStore({ privateDir: dataDir }).add({ name: 'core-1', value: 'test-key' });
  const made = spawnSync(process.execPath, ['scripts/client-token.ts', 'add', 'cli', '--kind', 'cli'], {
    cwd: REPO,
    env: { PATH: process.env.PATH, NEPTUNIA_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(made.status, 0, made.stderr);
  try {
    await withCapturedLogs(async () => {
      const core = await startCore({
        paths: { rootDir: REPO, privateDir: dataDir, dataDir },
        env: {},
        interfaces: [],
        llm: { complete: () => Promise.resolve({ text: '<msg>x</msg>', usage: {}, estimated: 1 }) },
        embedder: { embed: () => Promise.resolve([]) },
      });
      try {
        await body({
          dataDir,
          connect: () => connectSocket({ path: join(dataDir, 'run', 'core.sock'), maxFrameBytes: 16 * 1024 * 1024 }),
          token: readFileSync(join(dataDir, 'clients', 'cli.token'), 'utf8').trim(),
        });
      } finally {
        await core.stop();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The names the memory holds for `cli`, read until `ready` accepts them or five seconds pass (the write is async). */
async function storedNames(dataDir: string, ready: (found: ReturnType<typeof interfaceNamesOf>) => boolean) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
    try {
      const found = interfaceNamesOf(handle.db as Parameters<typeof interfaceNamesOf>[0], 'cli');
      if (ready(found) || Date.now() > deadline) return found;
    } finally {
      handle.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('a command line client connected over the socket has its declared names stored', async () => {
  // Bug: a hello of a principal of kind `cli` went through neither `connectInterface` nor the in-process path, so the
  // row of `cli` kept `name` and `extra` empty and its chat read with the bare kind and the interface id.
  await withCore(async ({ dataDir, connect, token }) => {
    const cli = await startCli({ connect, token, print: null });
    try {
      const found = await storedNames(dataDir, (one) => one.name !== null);
      assert.deepEqual(found, EXPECTED);
    } finally {
      await cli.stop();
    }
  });
});

test('a later hello of the command line without names keeps the stored ones', async () => {
  // Bug: the names are written by a hello that carries them, and a hello without them must not clear what is stored.
  await withCore(async ({ dataDir, connect, token }) => {
    const first = await startCli({ connect, token, print: null });
    await storedNames(dataDir, (one) => one.name !== null);
    await first.stop();
    const adapter = createFakeAdapter({ iface: 'cli', selfId: 'owner' });
    const bare = serveAdapter({
      transport: await connect(),
      hello: {
        iface: 'cli',
        self: { id: 'owner', name: 'owner' },
        root: null,
        capabilities: adapter.capabilities(),
        resume: null,
      },
      token,
      adapter,
      log: QUIET,
    });
    try {
      // A hello needs a moment to be written; the names must still stand after it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const found = await storedNames(dataDir, (one) => one.name !== null);
      assert.deepEqual(found, EXPECTED);
    } finally {
      bare.close();
    }
  });
});
