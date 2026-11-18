// What the core's start does with the GIF library (src/core.ts): nothing. Spec 2026-11-18, the library without the
// keeper: no start-up step asks the describer for the library or downloads a file. Bug: the start-up pass asked a GIF
// site's page link for the file of every entry without one, at every start, and never got a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { writeGifLibrary } from '../src/memory/db/gif-library.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { settle, withFakeCore } from './fixtures/core-over-fake.ts';

const AT = Date.UTC(2026, 10, 18);

/** A library of three link GIFs with descriptions and no files, as a start finds an old one. */
function seedLibrary(dataDir: string): void {
  const handle = openMemoryDb(join(dataDir, 'memory.db'));
  try {
    const db = dbOf(handle);
    const put: Record<string, object> = {};
    for (const n of [1, 2, 3]) {
      put[`k${n}`] = {
        id: `g${n}`,
        kind: 'link',
        url: `https://gifs.example/view/${n}`,
        fileUrl: `https://media.gifs.example/${n}.mp4`,
        itemId: `m${n}#e0`,
        nativeIds: [`m${n}#e0`],
        links: [`https://gifs.example/view/${n}`],
        count: 1,
        last: AT,
        firstSeen: AT,
      };
    }
    writeGifLibrary(db, { put }, { iface: 'fake', at: AT });
  } finally {
    handle.close();
  }
}

test('the start asks no address of a library GIF that has no file', async () => {
  const asked: Array<string> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: Parameters<typeof fetch>[0]) => {
    const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    asked.push(address);
    return Promise.reject(new Error('no network in a test'));
  };
  try {
    await withFakeCore({ prepare: seedLibrary }, async () => {
      await settle(500);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(
    asked.filter((address) => address.includes('gifs.example')),
    []
  );
});
