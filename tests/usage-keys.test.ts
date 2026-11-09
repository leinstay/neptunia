// Tests for the key rows of the usage accumulator (src/tools/operations/usage.ts) and the key name on the usage line of the chat
// client (src/llm/openrouter.ts): the spend by key name is what the balance of a key's grant is computed from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsage, usageTap } from '../src/tools/operations/usage.ts';
import { createLlm } from '../src/llm/openrouter.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const dir = () => fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'usage-keys-'));

test('keyCost: sums the requests on one key from the given day through today, and nothing for another key', () => {
  const clock = { at: Date.parse('2026-11-14T12:00:00Z') };
  const usage = createUsage({ dataDir: dir(), now: () => clock.at });
  usage.record({ role: 'core', key: 'OPENROUTER_CORE_KEY', cost: 3 });
  clock.at = Date.parse('2026-11-15T01:00:00Z');
  usage.record({ role: 'core', key: 'OPENROUTER_CORE_KEY', cost: 2 });
  usage.record({ role: 'core', key: 'OPENROUTER_CORE_BACKUP_KEY', cost: 7 });
  usage.record({ role: 'core', cost: 11 });
  clock.at = NOW;
  // Bug caught: the spend before the reset day counted against the new grant.
  assert.equal(usage.keyCost('OPENROUTER_CORE_KEY', '2026-11-15'), 2);
  assert.equal(usage.keyCost('OPENROUTER_CORE_KEY', '2026-11-01'), 5);
  assert.equal(usage.keyCost('OPENROUTER_CORE_BACKUP_KEY', '2026-11-15'), 7);
  assert.equal(usage.keyCost('OPENROUTER_NOBODY', '2026-11-01'), 0);
});

test('keyCost: survives a save and a load, and a file written before the key rows loads as it was', async () => {
  const where = dir();
  const first = createUsage({ dataDir: where, now: () => NOW });
  first.record({ role: 'core', key: 'OPENROUTER_CORE_KEY', cost: 4 });
  await first.save({ force: true });
  assert.equal(createUsage({ dataDir: where, now: () => NOW }).keyCost('OPENROUTER_CORE_KEY', '2026-11-01'), 4);
  const old = dir();
  fs.writeFileSync(
    path.join(old, 'usage.json'),
    JSON.stringify({ v: 1, days: { '2026-11-20': { core: { requests: 1 } } } })
  );
  assert.equal(createUsage({ dataDir: old, now: () => NOW }).keyCost('OPENROUTER_CORE_KEY', '2026-11-01'), 0);
});

test('usageTap: the key name of an llm: usage line reaches the key rows, a line without one counts for the main key', () => {
  const usage = createUsage({ dataDir: dir(), now: () => NOW });
  const tap = usageTap(usage);
  tap({ msg: 'llm: usage', role: 'core', key: 'OPENROUTER_CORE_BACKUP_KEY', cost: 1.5 });
  tap({ msg: 'llm: usage', role: 'core', cost: 9 });
  assert.equal(usage.keyCost('OPENROUTER_CORE_BACKUP_KEY', '2026-11-01'), 1.5);
  // A line without a key is a request on the main key.
  assert.equal(usage.keyCost('OPENROUTER_CORE_KEY', '2026-11-01'), 9);
});

function coreLlm() {
  const llm = createLlm({
    apiKey: 'core-a',
    getConfig: () =>
      ({
        models: { base: { core: 'x/core' } },
        llm: {
          baseUrl: 'http://x',
          timeoutMs: 1000,
          retries: 0,
          maxRequestTokens: 1e6,
          maxOutputTokens: 10,
          maxRequestsPerDay: 100,
        },
      }) as never,
    calibrator: { apply: (n: number) => n, observe() {} },
    state: { data: {}, markDirty() {} },
    now: () => NOW,
    fetchImpl: (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () =>
          Promise.resolve({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, cost: 0.5 } }),
      })) as never,
  });
  const ask = () => withCapturedLogs(() => llm.complete([{ role: 'user', content: 'hi' }], { role: 'core' }));
  return { ask };
}

test('createLlm: a request on the main key leaves the key field out of the usage line', async () => {
  const { ask } = coreLlm();
  const { logs } = await ask();
  assert.ok(!('key' in (logs.find((line) => line.msg === 'llm: usage') ?? {})));
});
