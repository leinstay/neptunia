import { test } from 'node:test';
import assert from 'node:assert/strict';
import { log, onLog } from '../../src/log.ts';
import { withCapturedLogs } from '../fixtures/capture-logs.ts';

test('log: a listener gets each entry after it is written; a throwing listener is ignored', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const offThrow = onLog(() => {
    throw new Error('listener failure');
  });
  const off = onLog((entry) => seen.push(entry));
  try {
    const { logs } = await withCapturedLogs(() => log.info('test: tapped', { ms: 12 }));
    assert.equal(logs.length, 1, 'the line was written');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].msg, 'test: tapped');
    assert.equal(seen[0].ms, 12);
    assert.equal(seen[0].level, 'info');
  } finally {
    off();
    offThrow();
  }
  await withCapturedLogs(() => log.info('test: after'));
  assert.equal(seen.length, 1, 'an unsubscribed listener hears nothing');
});
