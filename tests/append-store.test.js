// Tests for src/memory/append-store.js: serialized JSONL appends, tail recovery,
// streaming reads, the retry queue and locked rewrites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAppendStore } from '../src/memory/append-store.js';
import { tempDir } from './fixtures/tmp.js';

function tmpDir() {
  return tempDir('nep-append-');
}

function quietLog() {
  const calls = [];
  return {
    calls,
    info: (msg, meta) => calls.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => calls.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => calls.push({ level: 'error', msg, meta }),
  };
}

// An in-memory stand-in for node:fs/promises with switchable write failures
// and a count of fsync calls.
function memoryFs() {
  const files = new Map();
  const ctl = { failWrites: false, syncs: 0 };
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const get = (p) => {
    if (!files.has(p)) throw enoent(p);
    return files.get(p);
  };
  const handle = (p) => ({
    async write(data) {
      if (ctl.failWrites) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      const buf = Buffer.from(String(data), 'utf8');
      files.set(p, Buffer.concat([files.get(p) ?? Buffer.alloc(0), buf]));
      return { bytesWritten: buf.length };
    },
    async read(buffer, offset, length, position) {
      const src = get(p);
      const n = src.copy(buffer, offset, position, Math.min(src.length, position + length));
      return { bytesRead: n, buffer };
    },
    async sync() { ctl.syncs += 1; },
    async close() {},
  });
  const api = {
    async open(p, flags) {
      if (flags === 'a') { if (!files.has(p)) files.set(p, Buffer.alloc(0)); }
      else if (flags === 'w') files.set(p, Buffer.alloc(0));
      else get(p);
      return handle(p);
    },
    async readFile(p) { return get(p); },
    async writeFile(p, data) { files.set(p, Buffer.from(data)); },
    async rename(a, b) { files.set(b, get(a)); files.delete(a); },
    async stat(p) { return { size: get(p).length }; },
    async truncate(p, len) { files.set(p, get(p).subarray(0, len)); },
    async mkdir() {},
    async unlink(p) { files.delete(p); },
  };
  return { api, files, ctl };
}

test('append-store: appends whole lines in order under concurrent calls', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'day.jsonl');
  const store = createAppendStore({ log: quietLog() });
  await Promise.all(Array.from({ length: 100 }, (_, i) => store.append(file, JSON.stringify({ i, t: 'αβγ' }))));
  await store.close();
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines.pop(), '');
  assert.equal(lines.length, 100);
  assert.deepEqual(lines.map((l) => JSON.parse(l).i), Array.from({ length: 100 }, (_, i) => i));
});

test('append-store: recovers a torn tail on open', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'day.jsonl');
  fs.writeFileSync(file, 'a\nb');
  const store = createAppendStore({ log: quietLog(), now: () => 1234 });
  const result = await store.recover(file);
  assert.deepEqual(result, { truncated: 1, tornFile: `${file}.torn-1234` });
  assert.equal(fs.readFileSync(`${file}.torn-1234`, 'utf8'), 'b');
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\n');
  await store.append(file, 'c');
  await store.close();
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nc\n');

  // The first append of a fresh store recovers by itself.
  const other = path.join(dir, 'other.jsonl');
  fs.writeFileSync(other, 'x\ny\nhalf');
  const second = createAppendStore({ log: quietLog(), now: () => 99 });
  await second.append(other, 'z');
  await second.close();
  assert.equal(fs.readFileSync(other, 'utf8'), 'x\ny\nz\n');
  assert.equal(fs.readFileSync(`${other}.torn-99`, 'utf8'), 'half');
  const clean = await createAppendStore({ log: quietLog() }).recover(other);
  assert.deepEqual(clean, { truncated: 0, tornFile: null });
});

test('append-store: iterate skips a torn tail and yields offsets', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'day.jsonl');
  fs.writeFileSync(file, 'one\nδύο\nthree\ntorn');
  const store = createAppendStore({ log: quietLog() });
  const seen = [];
  for await (const item of store.iterate(file)) seen.push(item);
  assert.deepEqual(seen, [
    { offset: 0, line: 'one' },
    { offset: 4, line: 'δύο' },
    { offset: 4 + Buffer.byteLength('δύο\n'), line: 'three' },
  ]);
  const from = [];
  for await (const item of store.iterate(file, { from: seen[2].offset })) from.push(item);
  assert.deepEqual(from, [seen[2]]);
  const missing = [];
  for await (const item of store.iterate(path.join(dir, 'none.jsonl'))) missing.push(item);
  assert.deepEqual(missing, []);
});

test('append-store: a failing fs queues up to retryMax then rejects', async () => {
  const mem = memoryFs();
  const log = quietLog();
  const store = createAppendStore({ fs: mem.api, log, retryMax: 1000 });
  const file = path.join('mem', 'day.jsonl');
  await store.append(file, 'first');
  mem.ctl.failWrites = true;
  for (let i = 0; i < 1000; i += 1) await store.append(file, `line-${i}`);
  assert.equal(store.stats().pending, 1000);
  assert.equal(store.stats().stalled, true);
  assert.ok(store.stats().failed >= 1);
  await assert.rejects(store.append(file, 'one-too-many'), (err) => err.code === 'append-stalled');
  const warns = log.calls.filter((c) => c.level === 'warn');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].msg, 'store: append failed');
  assert.deepEqual(warns[0].meta, { file: 'day.jsonl', pending: 1 });

  mem.ctl.failWrites = false;
  await store.flush(file);
  assert.equal(store.stats().pending, 0);
  assert.equal(store.stats().stalled, false);
  const lines = mem.files.get(file).toString('utf8').split('\n');
  lines.pop();
  assert.deepEqual(lines, ['first', ...Array.from({ length: 1000 }, (_, i) => `line-${i}`)]);
  const recovered = log.calls.filter((c) => c.msg === 'store: append recovered');
  assert.deepEqual(recovered.map((c) => c.meta), [{ file: 'day.jsonl', drained: 1000 }]);
  await store.append(file, 'after');
  await store.close();
  assert.ok(mem.files.get(file).toString('utf8').endsWith('line-999\nafter\n'));
});

test('append-store: rewrite keeps only matching lines and is atomic', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'day.jsonl');
  const store = createAppendStore({ log: quietLog() });
  for (const who of ['u1', 'u2', 'u1', 'u3']) await store.append(file, JSON.stringify({ who }));
  const result = await store.rewrite(file, (line) => JSON.parse(line).who !== 'u1');
  assert.deepEqual(result, { kept: 2, dropped: 2 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"who":"u2"}\n{"who":"u3"}\n');

  const before = fs.readFileSync(file, 'utf8');
  let seen = 0;
  await assert.rejects(store.rewrite(file, () => {
    seen += 1;
    if (seen === 2) throw new Error('predicate failed');
    return false;
  }), /predicate failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  await store.append(file, '{"who":"u4"}');
  await store.close();
  assert.equal(fs.readFileSync(file, 'utf8'), `${before}{"who":"u4"}\n`);
});

test('append-store: sync append calls fsync', async () => {
  const mem = memoryFs();
  let clock = 0;
  const store = createAppendStore({ fs: mem.api, log: quietLog(), fsyncMs: 500, now: () => clock });
  await store.append('day.jsonl', 'a');
  assert.equal(mem.ctl.syncs, 0);
  await store.append('day.jsonl', 'b', { sync: true });
  assert.equal(mem.ctl.syncs, 1);
  clock = 499;
  await store.append('day.jsonl', 'c');
  assert.equal(mem.ctl.syncs, 1);
  clock = 500;
  await store.append('day.jsonl', 'd');
  assert.equal(mem.ctl.syncs, 2);
  await store.flush();
  assert.equal(mem.ctl.syncs, 2);
  await store.append('day.jsonl', 'e');
  await store.flush('day.jsonl');
  assert.equal(mem.ctl.syncs, 3);
  await store.close();
  assert.equal(mem.files.get('day.jsonl').toString('utf8'), 'a\nb\nc\nd\ne\n');
});
