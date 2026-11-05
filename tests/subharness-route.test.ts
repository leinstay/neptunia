// src/subharness/control.ts#routeOfAgent: the path of an agent the core puts inside a task, as keys.json holds it now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as control from '../src/subharness/control.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

test('the route of an agent is its backend, model, effort and mode as keys.json holds them', () => {
  // Catches: one of the four fields comes from elsewhere, so the runner runs another path than the status shows.
  const dir = tempDir('nep-route-');
  writeKeysFile(dir, {
    subharness: {
      backends: ['codex', 'claude'],
      key: null,
      modes: { scout: 'full' },
      models: { scout: 'claude-opus-5-5', server: 'gpt-6-sol' },
      efforts: { scout: 'high' },
      uses: { scout: 'claude' },
    },
  });
  assert.deepEqual(control.routeOfAgent(dir, 'scout'), {
    backend: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
    mode: 'full',
  });
});

test('the route of an agent with nothing stored is the first connected backend, no model, no effort, the default mode', () => {
  // Catches: a missing model arrives as undefined and the line drops the field, or the mode is left out for the runner to guess.
  const dir = tempDir('nep-route-');
  writeKeysFile(dir, { subharness: { backends: ['codex', 'claude'], key: null, modes: {} } });
  assert.deepEqual(control.routeOfAgent(dir, 'server'), { backend: 'codex', model: null, effort: null, mode: 'read' });
});

test('an agent has no route while nothing is connected', () => {
  // Catches: an empty switch yields a route with a null backend, which the runner refuses as bad-route instead of subharness-off.
  const dir = tempDir('nep-route-');
  writeKeysFile(dir, { subharness: { backends: [], key: null, modes: {} } });
  assert.equal(control.routeOfAgent(dir, 'scout'), null);
});
