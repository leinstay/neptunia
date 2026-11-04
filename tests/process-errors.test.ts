// The core's guard over uncaught errors (src/process-errors.ts), in a child process, because the guard's whole point is
// what happens to the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const CHILD = new URL('./fixtures/process-errors-child.ts', import.meta.url).pathname;
const run = (code: string) => spawnSync(process.execPath, ['--no-warnings', CHILD, code], { encoding: 'utf8' });

test('the process lives through an idle HTTP/2 stream closed with no listener', () => {
  // Bug: undici's "socket idle timeout" reached no listener and ended the core in the middle of her turns.
  const child = run('UND_ERR_INFO');
  assert.equal(child.status, 0);
  assert.equal(child.stdout, 'alive');
});

test('any other uncaught error still ends the process with exit 1', () => {
  // Bug: a guard that swallows everything leaves a broken core running.
  const child = run('ERR_OTHER');
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
});
