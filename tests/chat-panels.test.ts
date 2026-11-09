// Panel commands use the same core operations as typed commands, without running setup on a mere view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatPanel } from '../bin/chat-panels.ts';
import { modelRoleRegistry } from '../src/subharness/model-capabilities.ts';
import type { RoleSources } from '../src/subharness/model-capabilities.ts';

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

// `/model` in the chat opens the nested selector (bin/chat-panels.ts): opening runs nothing, its read and its commit are
// the ordinary commands, and every other `/model` line keeps the normal command path. The same line in Bash stays `show`.

type Called = { name: string; args: Record<string, unknown> };

function runner(answer: (one: Called) => { status: string; text: string; code?: string }) {
  const calls: Array<Called> = [];
  const run = (one: Called): Promise<{ status: string; text: string; code?: string }> => {
    calls.push(one);
    return Promise.resolve(answer(one));
  };
  return { calls, run };
}

test('a bare /model opens the picker and runs no command, no probe and no write', async () => {
  // Catches: a read-only open spending a request or changing a setting.
  const { calls, run } = runner(() => ({ status: 'ok', text: '' }));
  const panel = await chatPanel('/model', run);
  assert.deepEqual(panel?.picker?.registry, modelRoleRegistry());
  assert.deepEqual(calls, []);
});

test('its read is /model sources for the concrete role, parsed back into descriptors', async () => {
  // Catches: the chooser reading sources by a display name, or by a second path beside the command table.
  const answer: RoleSources = { role: 'speech', current: null, sources: [] };
  const { calls, run } = runner(() => ({ status: 'ok', text: JSON.stringify(answer) }));
  const panel = await chatPanel('/model', run);
  assert.deepEqual(await panel?.picker?.read('speech'), answer);
  assert.deepEqual(calls, [{ name: 'model.sources', args: { role: 'speech' } }]);
});

test('a refused read rejects, so the selector shows a failure and not an empty list', async () => {
  // Catches: JSON.parse of a refusal, or a failed read drawn as a role with no source.
  const { run } = runner(() => ({ status: 'failed', text: 'the core said no' }));
  const panel = await chatPanel('/model', run);
  await assert.rejects(() => panel?.picker?.read('speech') ?? Promise.resolve());
});

test('its commit is the checked model.set command, once, and keeps the code of a refusal', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Catches: a second save path around the checked selection, or the refusal's code lost on the way to the screen.
  const { calls, run } = runner(() => ({ status: 'failed', code: 'model-rejected', text: 'no' }));
  const panel = await chatPanel('/model', run);
  const command = { name: 'model.set', args: { role: 'dev', model: 'sonnet', via: 'claude-harness' } } as const;
  const answer = await panel?.picker?.commit(command);
  assert.deepEqual(calls, [command]);
  assert.equal(answer?.code, 'model-rejected');
});

for (const line of ['/model show', '/model set core vendor/text-1']) {
  test(`${line} keeps the normal command path`, async () => {
    // Catches: the selector taking over a typed command, so a script's line stops working in the chat.
    const { calls, run } = runner(() => ({ status: 'ok', text: '' }));
    assert.equal(await chatPanel(line, run), null);
    assert.deepEqual(calls, []);
  });
}
