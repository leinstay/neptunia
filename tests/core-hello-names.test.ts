// The names an interface declares in its hello (`hello.names`: its name, its noun per kind of place, its word for a
// direct chat) reach the memory whether or not the hello names a root. `startCore` over temporary folders, the fake
// interface started in the core's process (the way the command line is) and the memory database read through a second,
// read-only connection. Made-up names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyStore } from '../src/keys/store.ts';
import { startCore } from '../src/core.ts';
import { start } from '../src/interface/fake-interface.ts';
import { interfaceNamesOf } from '../src/memory/db/frame-reads.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { chainsOf } from './fixtures/chains.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const NAMES = { interface: 'Solo Net', nouns: { channel: 'room' }, dm: 'private line' };

/** Starts a core whose one in-process interface says hello with `NAMES` and no root, then reads what the memory holds. */
async function namesAfterHello(): Promise<ReturnType<typeof interfaceNamesOf>> {
  const root = mkdtempSync(join(tmpdir(), 'hn-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({ bot: { timezone: 'UTC', owners: [] }, models: { routes: chainsOf({ video: false }) } })
  );
  createKeyStore({ privateDir: dataDir }).add({ name: 'core-1', value: 'test-key' });
  try {
    const { result } = await withCapturedLogs(async () => {
      const core = await startCore({
        paths: { rootDir: REPO, privateDir: dataDir, dataDir },
        env: {},
        interfaces: [{ name: 'solo', start: (host) => start(host, { selfId: 'self-id', root: null, names: NAMES }) }],
        llm: { complete: () => Promise.resolve({ text: '<msg>x</msg>', usage: {}, estimated: 1 }) },
        embedder: { embed: () => Promise.resolve([]) },
      });
      try {
        // The write goes through the one writer asynchronously: read until the name shows or the time is up.
        const deadline = Date.now() + 5000;
        for (;;) {
          const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
          try {
            const found = interfaceNamesOf(handle.db as Parameters<typeof interfaceNamesOf>[0], 'solo');
            if (found.name !== null || Date.now() > deadline) return found;
          } finally {
            handle.close();
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        await core.stop();
      }
    });
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a hello that carries names and no root stores the interface name, its nouns and its word for a direct chat', async () => {
  // Bug: the primary hello was written with its roots only and without its names, so an interface that serves no root
  // (the command line) kept `name` and `extra` empty and its chat read with the bare kind and the interface id.
  const found = await namesAfterHello();
  assert.deepEqual(found, { name: 'Solo Net', nouns: { channel: 'room' }, dm: 'private line' });
});
