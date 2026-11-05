// A sample (`sampleTime`, src/memory/db/recall.ts) through the reader thread: the rule of which places it may read is a
// function, so the main thread turns it into a list, and the worker answers from that list what the synchronous search
// answers. Synthetic data on a real file database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { channelPlaceId } from '../src/memory/db/ids.ts';
import { dbSettings, search } from '../src/memory/db/recall.ts';
import { groupContext } from '../src/memory/db/scope.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { fixture } from './fixtures/memory-db-recall.ts';
import { labels } from './fixtures/labels.ts';
import { config } from './fixtures/recall-run-kit.ts';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const DAY_START = Date.parse('2026-11-01T00:00:00.000Z');
const HOUR = 3600000;
const MAIN = channelPlaceId('discord', 'main');
const OTHER = channelPlaceId('discord', 'other');
const SHUT = channelPlaceId('discord', 'shut');

async function setup() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-sampled-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const env = fixture();
  for (let i = 0; i < 12; i += 1) {
    env.say({ native: `main-${i}`, at: DAY_START + i * HOUR, text: `line main ${i}`, place: MAIN });
    env.say({ native: `other-${i}`, at: DAY_START + i * HOUR + 1, text: `line other ${i}`, place: OTHER });
    env.say({ native: `shut-${i}`, at: DAY_START + i * HOUR + 2, text: `line shut ${i}`, place: SHUT });
  }
  env.stem();
  fillEnvAudiences(env);
  env.db.prepare('VACUUM INTO ?').run(path.join(data, 'memory.db'));
  env.done();
  const hot = {
    config: config({
      features: { recall: true, meaningSearch: false },
      memoryDb: { session: { mode: 'off' }, closeTimeoutMs: 500 },
    }),
    prompts: { labels },
  };
  const service = createMemoryDb({ hot, dataDir: data, now: () => NOW });
  await service.open();
  return {
    service,
    done: async () => {
      await service.close().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const theDay = (extra: Record<string, unknown> = {}) => ({
  ctx: groupContext('discord'),
  plan: { forms: [], who: [], from: DAY_START, to: DAY_START + 24 * HOUR - 1 },
  limit: 3,
  now: NOW,
  settings: dbSettings({}),
  sampleTime: true,
  ...extra,
});

test('a sample through the reader answers what the synchronous search answers, sampled included', async () => {
  const env = await setup();
  try {
    const args = theDay({
      allowPlace: (place: string) => place !== OTHER,
      samplePlace: (place: string) => place !== SHUT,
    });
    const expected = search(env.service.database(), args);
    assert.equal(expected.sampled, true);
    const found = await env.service.searchRecord(args);
    assert.deepEqual(found, expected);
    assert.ok(found.hits.length > 0);
    assert.ok(found.hits.every((hit) => hit.placeId === MAIN));
  } finally {
    await env.done();
  }
});

test('a rule that refuses every place answers nothing through the reader, and not sampled', async () => {
  const env = await setup();
  try {
    const found = await env.service.searchRecord(theDay({ samplePlace: () => false }));
    assert.deepEqual([found.hits.length, found.windows.length, found.sampled], [0, 0, false]);
  } finally {
    await env.done();
  }
});

test('a word search through the reader ignores the sample rule and says it is no sample', async () => {
  const env = await setup();
  try {
    const found = await env.service.searchRecord(
      theDay({ plan: { forms: ['shut'], who: [], from: null, to: null }, samplePlace: () => false })
    );
    assert.ok(found.hits.length > 0);
    assert.equal(found.sampled, false);
  } finally {
    await env.done();
  }
});
