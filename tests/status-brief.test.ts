// src/interface/commands/status-brief.ts: the facts the chat's header reads, from what the core already holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusBrief } from '../src/interface/commands/status-brief.ts';
import type { StatusBriefDeps } from '../src/interface/commands/status-brief.ts';

const CONFIG = {
  models: {
    base: { core: 'anthropic/claude-opus-4.6', memory: 'anthropic/claude-opus-4.6', analyzer: 'google/flash' },
  },
  memoryDb: { session: { mode: 'apply' } },
};

function deps(over: Partial<StatusBriefDeps> = {}): StatusBriefDeps {
  return {
    config: () => CONFIG,
    paused: () => false,
    pauseReason: () => null,
    path: () => ({ kind: 'direct' }),
    hasKey: () => true,
    probe: () => ({ ok: true, at: 500 }),
    runFailed: () => false,
    interfaces: () => [{ name: 'discord', enabled: true, connected: true }],
    ...over,
  };
}

test('a role on a harness names the harness route and the model that harness runs', () => {
  // Bug: the header shows the role's API model beside the harness's own model name, so the model is named twice.
  const brief = statusBrief(
    deps({
      path: (role) =>
        role === 'core'
          ? { kind: 'subharness', backend: 'claude', model: 'claude-opus-4-6' }
          : { kind: 'subharness', backend: 'codex', model: 'gpt-5.5' },
      hasKey: () => false,
    })
  );
  assert.equal(brief.core.route, 'claude-harness');
  assert.equal(brief.core.model, 'claude-opus-4-6');
  assert.equal(brief.memory.route, 'codex-harness');
  assert.equal(brief.memory.model, 'gpt-5.5');
  assert.equal(brief.core.bound, true, 'a harness needs no key');
  assert.equal(brief.memory.bound, true);
});

test('a role on the API names the API route, its configured model and whether a key carries it', () => {
  // Bug: the analyzer's model and route are not read at all, or a role with no key passes for a working one.
  const brief = statusBrief(deps({ hasKey: (role) => role !== 'analyzer' }));
  assert.equal(brief.analyzer.route, 'direct-api');
  assert.equal(brief.analyzer.model, 'google/flash');
  assert.equal(brief.analyzer.bound, false);
  assert.equal(brief.memory.route, 'direct-api');
  assert.equal(brief.memory.model, 'anthropic/claude-opus-4.6');
  assert.equal(brief.memory.bound, true);
});

test('the analyzer is read on the API even when the core runs on a harness', () => {
  // Bug: the analyzer borrows the core's harness route, which it can never run on.
  const brief = statusBrief(
    deps({ path: () => ({ kind: 'subharness', backend: 'claude', model: 'claude-opus-4-6' }) })
  );
  assert.equal(brief.analyzer.route, 'direct-api');
  assert.equal(brief.analyzer.model, 'google/flash');
});

test('the pause with its reason, the memory session mode and the last probe come through as they are', () => {
  // Bug: a paused core or a memory session that is off reads as running.
  const brief = statusBrief(
    deps({
      paused: () => true,
      pauseReason: () => 'memory-down',
      config: () => ({ ...CONFIG, memoryDb: { session: { mode: 'off' } } }),
      probe: () => ({ ok: false, code: 'refused', at: 700 }),
    })
  );
  assert.deepEqual(
    [brief.core.state, brief.core.reason, brief.memory.session, brief.memory.probe, brief.memory.checkedAt],
    ['paused', 'memory-down', 'off', 'failed', 700]
  );
  const fresh = statusBrief(deps({ probe: () => null }));
  assert.deepEqual([fresh.core.state, fresh.core.reason, fresh.memory.probe], ['running', null, 'unknown']);
});

test('a harness role whose last run lost its login reads as unbound, so the header says error', () => {
  // Catches: a core on a harness whose login dropped still shown active, the owner's case of 2026-11-08.
  const brief = statusBrief(
    deps({
      path: () => ({ kind: 'subharness', backend: 'claude', model: 'claude-opus-4-6' }),
      runFailed: (role) => role === 'core',
    })
  );
  assert.equal(brief.core.bound, false);
  assert.equal(brief.memory.bound, true);
});

test('a lost login is read for the harness the role runs through now', () => {
  // Catches: a core moved from codex to claude after codex lost its login still shown as error.
  const asked: Array<string> = [];
  const brief = statusBrief(
    deps({
      path: (role) =>
        role === 'core' ? { kind: 'subharness', backend: 'claude', model: 'claude-opus-4-6' } : { kind: 'direct' },
      runFailed: (role, backend) => {
        asked.push(`${role}:${backend}`);
        return backend === 'codex';
      },
    })
  );
  assert.equal(brief.core.bound, true);
  assert.deepEqual(asked, ['core:claude', 'memory:api', 'analyzer:api']);
});

test('a role on the API whose last run failed reads as unbound though a key carries it', () => {
  // Catches: an analyzer whose key the provider refuses (401) still shown active because a key is set.
  const brief = statusBrief(deps({ runFailed: (role, backend) => role === 'analyzer' && backend === 'api' }));
  assert.equal(brief.analyzer.bound, false);
  assert.equal(brief.core.bound, true);
});
