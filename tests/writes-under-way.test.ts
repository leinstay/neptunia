// The writes a module store sends straight to the memory writer (src/memory/db/writes-under-way.ts): a failed write is
// logged and handed back to the store, the drain sends what is unwritten again, and the shutdown's drain logs what it
// lost or stops waiting after its bound. Synthetic writes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWritesUnderWay } from '../src/memory/db/writes-under-way.ts';

type Line = { level: 'warn' | 'error'; message: string; fields: Record<string, unknown> };

function logs(): {
  log: {
    warn: (m: string, f?: Record<string, unknown>) => void;
    error: (m: string, f?: Record<string, unknown>) => void;
  };
  out: Array<Line>;
} {
  const out: Array<Line> = [];
  return {
    out,
    log: {
      warn: (message, fields = {}) => out.push({ level: 'warn', message, fields }),
      error: (message, fields = {}) => out.push({ level: 'error', message, fields }),
    },
  };
}

const closed = (): Promise<never> => Promise.reject(Object.assign(new Error('closed'), { code: 'DB_CLOSED' }));

test('a failed write is logged with its code and handed back to the store', async () => {
  const { log, out } = logs();
  const writes = createWritesUnderWay({ log, name: 'intentions' });
  let failed = 0;
  writes.track(closed, () => {
    failed += 1;
  });
  await writes.drain({ unwritten: () => 0, resend: () => {} });
  assert.equal(failed, 1);
  const line = out.find((entry) => entry.message === 'memory db: unit write failed');
  assert.equal(line?.fields.code, 'DB_CLOSED');
  assert.equal(line?.fields.reader, 'intentions');
});

test('the drain sends what a failed write left again and answers nothing unwritten once it landed', async () => {
  const { log } = logs();
  const writes = createWritesUnderWay({ log, name: 'tasks' });
  let unwritten = 0;
  const landed: Array<string> = [];
  writes.track(closed, () => {
    unwritten = 1;
  });
  const waiting = await writes.drain({
    unwritten: () => unwritten,
    resend: () =>
      writes.track(
        () => {
          landed.push('again');
          unwritten = 0;
          return Promise.resolve();
        },
        () => {}
      ),
  });
  assert.equal(waiting, 0);
  assert.deepEqual(landed, ['again']);
});

test('the shutdown drain logs as lost what still fails', async () => {
  const { log, out } = logs();
  const writes = createWritesUnderWay({ log, name: 'tasks' });
  let unwritten = 0;
  const failing = (): void =>
    writes.track(closed, () => {
      unwritten = 1;
    });
  failing();
  const waiting = await writes.drain({ final: true, unwritten: () => unwritten, resend: failing });
  assert.equal(waiting, 1);
  const lost = out.find((entry) => entry.message === 'memory db: units lost');
  assert.equal(lost?.level, 'error');
  assert.equal(lost?.fields.units, 1);
  assert.equal(lost?.fields.code, 'DB_CLOSED');
});

test('the shutdown drain stops waiting after timeoutMs and logs the writes still under way', async () => {
  // Bug: a write the writer never answered held the shutdown forever, with nothing in the log.
  const { log, out } = logs();
  const writes = createWritesUnderWay({ log, name: 'intentions' });
  writes.track(
    () => new Promise<never>(() => {}),
    () => {}
  );
  const hung = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000).unref());
  const waiting = await Promise.race([
    writes.drain({ final: true, timeoutMs: 30, unwritten: () => 0, resend: () => {} }),
    hung,
  ]);
  assert.equal(waiting, 1);
  const line = out.find((entry) => entry.message === 'memory db: writes still under way at shutdown');
  assert.equal(line?.fields.units, 1);
  assert.equal(line?.fields.ms, 30);
});

test('a write that throws before it starts is a failed write, not a thrown error', async () => {
  const { log } = logs();
  const writes = createWritesUnderWay({ log, name: 'tasks' });
  let failed = false;
  writes.track(
    () => {
      throw Object.assign(new Error('no writer'), { code: 'DB_CLOSED' });
    },
    () => {
      failed = true;
    }
  );
  await writes.drain({ unwritten: () => 0, resend: () => {} });
  assert.equal(failed, true);
});
