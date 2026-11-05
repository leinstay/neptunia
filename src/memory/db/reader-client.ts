// The service's side of the reader worker (reader-worker.ts): one thread, one message at a time, the others waiting here
// in arrival order. Waiting here, and not in the thread's port, is what lets an abandoned search go without taking the
// searches behind it along: the thread is terminated, a new one opens, and the queue goes on.
//
// `search(input, signal)` rejects with a code: `SEARCH_ABANDONED` when the signal aborts, `WORKER_EXIT` when the thread
// dies under the message (the next one starts a new thread), `DB_CLOSED` once `stop` ran, or the code the reader
// answered. A thread is held by the event loop only while a message waits for it.
// Counts and codes only in the logs, never a path, a name or a text.

import { Worker } from 'node:worker_threads';
import { namedResult } from './recall.ts';
import type { SearchInput, SearchResult } from './recall.ts';
import type { Log, Row } from './types.ts';

export const SEARCH_ABANDONED = 'SEARCH_ABANDONED';
const WORKER_EXIT = 'WORKER_EXIT';
const DB_CLOSED = 'DB_CLOSED';

export type ReaderClient = {
  /** Starts the thread when none runs and resolves once it is open or gone, so the next search does not pay for it. */
  warm(): Promise<void>;
  search(input: SearchInput, signal?: AbortSignal): Promise<SearchResult>;
  /** Refuses what waits with `DB_CLOSED` and ends the thread: closed within `timeoutMs` when idle, else terminated. */
  stop(timeoutMs: number): Promise<void>;
};

type Message = {
  id: number;
  type: string;
  payload: Row;
  signal: AbortSignal | undefined;
  onAbort: () => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type Thread = { worker: Worker; open: boolean; exited: Promise<void>; opened: Promise<void> };

const failure = (code: unknown, text: string): Error => Object.assign(new Error(text), { code });

/** `promise`, or nothing more after `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

export function createReaderClient({
  workerFile,
  dbPath,
  log,
}: {
  workerFile: string | URL;
  dbPath: string;
  log: Log;
}): ReaderClient {
  const waiting: Array<Message> = [];
  let running: Message | null = null;
  let thread: Thread | null = null;
  let stopped = false;
  let seq = 0;

  function settled(message: Message): void {
    message.signal?.removeEventListener('abort', message.onAbort);
    holdWhileNeeded();
  }

  function holdWhileNeeded(): void {
    if (!thread) return;
    if (running || waiting.length > 0) thread.worker.ref();
    else thread.worker.unref();
  }

  function reject(message: Message, code: string, text: string): void {
    message.reject(failure(code, text));
    settled(message);
  }

  function next(): void {
    if (stopped || running || waiting.length === 0) return;
    if (!thread) {
      thread = startThread();
      holdWhileNeeded();
      return;
    }
    if (!thread.open) return;
    running = waiting.shift() ?? null;
    if (!running) return;
    try {
      thread.worker.postMessage({ ...running.payload, id: running.id, type: running.type });
    } catch (error) {
      // A value that cannot cross a thread is this message's fault alone.
      const refused = running;
      running = null;
      reject(refused, (error as { name?: string } | null)?.name ?? 'ERROR', 'memory db reader call refused');
      next();
    }
  }

  function startThread(): Thread {
    const worker = new Worker(workerFile);
    let onExit: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      onExit = resolve;
    });
    let onOpen: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      onOpen = resolve;
    });
    const started: Thread = { worker, open: false, exited, opened };
    const openId = -1;
    worker.unref();
    worker.on('message', (message: Row | null) => {
      if (message?.type === 'ready') {
        worker.postMessage({ id: openId, type: 'open', path: dbPath });
        return;
      }
      if (thread !== started || !message) return;
      if (message.id === openId) {
        if (message.ok) {
          started.open = true;
          onOpen();
          next();
        } else {
          log.warn('memory db: reader open failed', { code: message.code as string });
          void worker.terminate();
        }
        return;
      }
      const answered = running;
      if (!answered || message.id !== answered.id) return;
      running = null;
      if (message.ok) answered.resolve(message.result);
      else answered.reject(failure(message.code, 'memory db reader call failed'));
      settled(answered);
      next();
    });
    worker.on('error', (error) => {
      if (thread === started) log.warn('memory db: reader failed', { code: (error as { code?: string }).code ?? null });
    });
    worker.on('exit', (exit) => {
      onExit();
      onOpen();
      if (thread !== started) return;
      thread = null;
      log.warn('memory db: reader exited', { code: WORKER_EXIT, exit });
      // A thread that never opened would be started again for ever: the first message in line pays for it.
      const lost = running ?? (started.open ? null : (waiting.shift() ?? null));
      running = null;
      if (lost) reject(lost, WORKER_EXIT, 'memory db reader stopped');
      next();
    });
    return started;
  }

  function abandon(message: Message): void {
    if (message === running) {
      running = null;
      const stuck = thread;
      thread = null;
      void stuck?.worker.terminate();
      reject(message, SEARCH_ABANDONED, 'memory db search abandoned');
      thread = startThread();
      holdWhileNeeded();
      return;
    }
    const at = waiting.indexOf(message);
    if (at >= 0) waiting.splice(at, 1);
    reject(message, SEARCH_ABANDONED, 'memory db search abandoned');
  }

  function call<TAnswer>(type: string, payload: Row, signal?: AbortSignal): Promise<TAnswer> {
    if (stopped) return Promise.reject(failure(DB_CLOSED, 'memory db is not open'));
    if (signal?.aborted) return Promise.reject(failure(SEARCH_ABANDONED, 'memory db search abandoned'));
    return new Promise<TAnswer>((resolve, rejectCall) => {
      seq += 1;
      const message: Message = {
        id: seq,
        type,
        payload,
        signal,
        onAbort: () => abandon(message),
        // Each type's reply is the shape its handler in reader-worker.ts returns.
        resolve: resolve as (value: unknown) => void,
        reject: rejectCall,
      };
      signal?.addEventListener('abort', message.onAbort, { once: true });
      waiting.push(message);
      next();
      holdWhileNeeded();
    });
  }

  async function search(input: SearchInput, signal?: AbortSignal): Promise<SearchResult> {
    const { nameOf, channelNameOf, allowPlace, ...data } = input;
    // `allowPlace` is typed `unknown` in `SearchInput`, as `search` reads it; a function of a place is its one use.
    const allows = typeof allowPlace === 'function' ? (allowPlace as (place: string | null) => unknown) : null;
    const allowedPlaces = allows
      ? (await call<Array<string | null>>('places', { ctx: input.ctx }, signal)).filter((place) =>
          Boolean(allows(place))
        )
      : undefined;
    const marked = await call<Parameters<typeof namedResult>[0]>(
      'search',
      { input: { ...data, ...(allowedPlaces ? { allowedPlaces } : {}) } },
      signal
    );
    return namedResult(marked, { nameOf, channelNameOf });
  }

  async function stop(timeoutMs: number): Promise<void> {
    stopped = true;
    const busy = running !== null;
    for (const message of [...(running ? [running] : []), ...waiting.splice(0)])
      reject(message, DB_CLOSED, 'memory db is not open');
    running = null;
    const ending = thread;
    thread = null;
    if (!ending) return;
    if (!busy && ending.open && timeoutMs > 0) {
      ending.worker.postMessage({ id: 0, type: 'close' });
      await within(ending.exited, timeoutMs);
    }
    await within(ending.worker.terminate(), timeoutMs);
  }

  return {
    warm: async () => {
      if (stopped) return;
      thread ??= startThread();
      await thread.opened;
    },
    search,
    stop,
  };
}
