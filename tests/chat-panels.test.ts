// Panel commands use the same core operations as typed commands, without running setup on a mere view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatPanel } from '../bin/chat-panels.ts';

test('editing a setting sends its path and value to config.set, not to the model', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const run = (command: { name: string; args: Record<string, unknown> }) => {
    calls.push(command);
    return Promise.resolve({
      status: 'ok',
      text: command.name === 'config.show' ? '{"heartbeat":{"enabled":false}}' : 'saved',
    });
  };
  const panel = await chatPanel('/config', run);
  const row = panel?.rows?.find((one) => one.id === 'heartbeat.enabled');
  assert.equal(row?.edit?.value, 'false');
  await row?.apply?.('true');
  assert.deepEqual(calls.at(-1), { name: 'config.set', args: { path: 'heartbeat.enabled', value: 'true' } });
});

test('setup shows choices without installing or probing, and a chosen key opens the existing secret dialog', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const panel = await chatPanel(
    '/setup',
    (command) => {
      calls.push(command);
      return Promise.resolve({ status: 'ok', text: 'done' });
    },
    ['discord', 'fake']
  );
  assert.deepEqual(calls, []);
  assert.ok(panel?.rows?.some((row) => row.id === 'interface:fake'));
  await panel?.rows?.find((row) => row.id === 'key')?.apply?.('primary');
  assert.deepEqual(calls, [{ name: 'keys.add', args: { name: 'primary' } }]);
});
