// PR 2, one setup flow and readiness: `/logs` reads the journal of the scope setup and `service` resolve
// (src/service/journal.ts), with the manager's failures told apart from an empty journal. The journal runner is a fake;
// one real process goes through it in tests/neptunia-cli-setup.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journalCall, readJournal } from '../src/service/journal.ts';
import type { RunResult } from '../src/setup/install.ts';

const USER = { NEPTUNIA_UNIT_SCOPE: 'user' };
const SYSTEM = { NEPTUNIA_UNIT_SCOPE: 'system' };

test('the call of each scope reads the journal that scope writes to', () => {
  // Catches: journalctl -u on the system journal for a user unit, which answers "no entries" for a healthy core.
  assert.deepEqual(journalCall(USER, 'errors'), [
    'journalctl',
    ['--user', '-u', 'neptunia-core.service', '--no-pager', '-p', 'err'],
  ]);
  assert.deepEqual(journalCall(SYSTEM, 'errors'), [
    'journalctl',
    ['-u', 'neptunia-core.service', '--no-pager', '-p', 'err'],
  ]);
});

const running = (result: RunResult) => () => Promise.resolve(result);

test('lines of the journal are the answer, and a journal with none says so', async () => {
  // Catches: an empty answer that a script cannot tell from a failure.
  const lines = await readJournal(USER, '', running({ code: 0, stdout: 'line one\n', stderr: '' }));
  assert.deepEqual(lines, { status: 'ok', text: 'line one\n' });
  const none = await readJournal(USER, '', running({ code: 0, stdout: '', stderr: '' }));
  assert.equal(none.status, 'ok');
  assert.equal(none.text, '(no lines)');
});

test('a permission failure is a failure that names the scope and keeps the reason', async () => {
  // Catches: "not seeing messages" printed as if it were the log, or a hint that sends the owner to the wrong manager.
  const reason = 'Hint: You are currently not seeing messages from other users and the system.';
  const answer = await readJournal(SYSTEM, '', running({ code: 1, stdout: '', stderr: reason }));
  assert.equal(answer.status, 'failed');
  assert.ok(answer.text.includes(reason), answer.text);
  assert.ok(answer.text.includes('system'), answer.text);
});

test('a manager that is unavailable is a failure that names the scope', async () => {
  // Catches: a user bus that is down reads as a core with no log.
  const reason = 'Failed to connect to bus: No medium found';
  const answer = await readJournal(USER, '', running({ code: 1, stdout: '', stderr: reason }));
  assert.equal(answer.status, 'failed');
  assert.ok(answer.text.includes(reason), answer.text);
  assert.ok(answer.text.includes('user'), answer.text);
});

test('a journalctl that cannot start is a failure, never a crash', async () => {
  // Catches: a host with no systemd throws out of a read-only command.
  const answer = await readJournal(USER, '', () =>
    Promise.reject(Object.assign(new Error('spawn journalctl ENOENT'), { code: 'ENOENT' }))
  );
  assert.equal(answer.status, 'failed');
  assert.ok(answer.text.includes('ENOENT'), answer.text);
});

test('follow is left to the chat, which keeps the process open for it', async () => {
  // Catches: a one-shot read handed -f, which never returns from a script.
  const calls: Array<ReadonlyArray<string>> = [];
  const answer = await readJournal(USER, 'follow', (_command, args) => {
    calls.push(args);
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  });
  assert.equal(answer.status, 'invalid');
  assert.deepEqual(calls, []);
});
