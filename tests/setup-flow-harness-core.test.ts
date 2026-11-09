// The core-model step of the setup flow (`setupFlowSteps`, src/setup/flow.ts) for a core that runs on a harness: it
// needs no API key, so the step never asks for a first core key. Everything before the step holds in the health the
// test hands the flow, and the core's commands are a fake that records what the step sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSetupFlow, setupFlowSteps } from '../src/setup/flow.ts';
import type { ReadinessHealth } from '../src/setup/readiness.ts';
import type { SetupOptions } from '../src/setup/run.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const SELECTION = 'openrouter:vendor/core-1';
const ON_CLAUDE = { backend: 'claude', model: 'claude-opus-4-6', effort: null };

function rig(harness: boolean, chain: Array<object> | null = null) {
  const base = tempDir('nep-flow-harness-');
  const options: SetupOptions = {
    system: false,
    user: 'alice',
    group: 'alice',
    home: path.join(base, 'home'),
    rootDir: path.join(import.meta.dirname, '..'),
    privateDir: path.join(base, 'data'),
    dataDir: path.join(base, 'data'),
    node: '/usr/bin/node',
    xdgConfigHome: path.join(base, 'xdg'),
  };
  writeKeysFile(options.privateDir, {
    subharness: { key: null, modes: {}, ...(harness ? { core: ON_CLAUDE } : {}) },
  });
  if (chain !== null) {
    const file = path.join(options.privateDir, 'config', 'config.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...stored, models: { routes: { core: chain } } }));
  }
  const commands: Array<{ name: string; args: Record<string, unknown> }> = [];
  const asked: Array<string> = [];
  let checked = false;
  const health = (): Promise<ReadinessHealth> =>
    Promise.resolve({
      identity: 'ok',
      config: 'ok',
      services: 'ok',
      core: 'listening',
      link: 'authenticated',
      model: { selection: SELECTION, check: checked ? { selection: SELECTION, ok: true, code: null, at: 1 } : null },
      memory: { service: 'ok', writer: 'ok' },
      optional: {},
    });
  const askCore = (command: { name: string; args: Record<string, unknown> }) => {
    commands.push(command);
    checked = true;
    return Promise.resolve({ status: 'ok', text: 'done' });
  };
  const ask = (question: string, offered: string | null): Promise<string> => {
    asked.push(question);
    return Promise.resolve(offered ?? '');
  };
  const flow = () =>
    runSetupFlow({
      dataDir: options.dataDir,
      health,
      ask,
      steps: setupFlowSteps(options, {
        run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
        askCore,
        openChat: () => Promise.resolve(),
      }),
    });
  return { flow, commands, asked };
}

test('with her core on a harness and no core key, the flow never asks for a first core key', async () => {
  // Catches: setup demanding an API key from an owner whose core runs on claude and needs none.
  const r = rig(true);
  const outcome = await r.flow();
  assert.equal(outcome.status, 'ready', outcome.detail);
  assert.ok(!r.asked.some((question) => question.includes('first key')), r.asked.join('\n'));
  assert.ok(!r.commands.some((command) => command.name === 'keys.add'), JSON.stringify(r.commands));
});

test('with her core on the API and no core key, the flow asks for the first core key', async () => {
  // Catches: the harness exemption applied to every core, which leaves a direct core with no key to run on.
  const r = rig(false);
  await r.flow();
  assert.ok(
    r.asked.some((question) => question.includes('first key')),
    r.asked.join('\n')
  );
});

test('with her core chain starting on a harness and no key, the flow never asks for a first key', async () => {
  // Catches: setup reading only the old harness record, so a core set to claude with /model set is asked for a key.
  const r = rig(false, [{ via: 'harness', backend: 'claude', model: 'claude-opus-4-6' }]);
  const outcome = await r.flow();
  assert.equal(outcome.status, 'ready', outcome.detail);
  assert.ok(!r.asked.some((question) => question.includes('first key')), r.asked.join('\n'));
});
