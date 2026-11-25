// The memory database's reader thread (reader-client.ts starts it with `node:worker_threads`). It holds one read-only
// connection and runs the long searches of recall (recall.ts), so a search over the whole record never stops the bot's
// main thread. It takes no lock and can write nothing: every message outside the list below is refused.
//
// Messages in  { id, type: 'open', path }             open the database read-only
//              { id, type: 'places', ctx }            the places a read context sees (recall.ts#visiblePlaces)
//              { id, type: 'search', input }          one search (recall.ts#searchMarked)
//              { id, type: 'close' }                  close the database, then the thread ends
// Messages out { type: 'ready' }                      once, when the thread listens
//              { id, ok: true, result } | { id, ok: false, code }   one reply per message
// Counts and codes only, never a path or a text.

import { parentPort } from 'node:worker_threads';
import { openMemoryDb } from './open.ts';
import { searchMarked, visiblePlaces } from './recall.ts';
import type { SearchInput } from './recall.ts';
import { dbOf } from './types.ts';
import type { MemoryHandle, Row } from './types.ts';

if (parentPort === null) throw new Error('the memory reader worker runs only as a worker thread of the service');
const port = parentPort;

let handle: MemoryHandle | null = null;

function database() {
  if (handle === null) throw Object.assign(new Error('the memory reader has no open database'), { code: 'DB_CLOSED' });
  return dbOf(handle);
}

const handlers = new Map<unknown, (message: Row) => unknown>([
  [
    'open',
    ({ path }) => {
      handle = openMemoryDb(path, { readOnly: true });
      return {};
    },
  ],
  ['places', ({ ctx }) => visiblePlaces(database(), ctx)],
  ['search', ({ input }) => searchMarked(database(), input as SearchInput)],
  [
    'close',
    () => {
      handle?.close();
      handle = null;
      return {};
    },
  ],
]);

port.on('message', (message: Row) => {
  const { id, type } = message;
  try {
    const handler = handlers.get(type);
    if (!handler) throw Object.assign(new Error('the memory reader only reads'), { code: 'READ_ONLY' });
    port.postMessage({ id, ok: true, result: handler(message) });
  } catch (error) {
    const { code, name } = (error ?? {}) as { code?: string; name?: string };
    port.postMessage({ id, ok: false, code: code ?? name ?? 'ERROR' });
  }
  if (type === 'close') port.close();
});

port.postMessage({ type: 'ready' });
