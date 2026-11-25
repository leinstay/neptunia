// The memory writer's path as the memory status line names it (src/subharness/memory-path.ts#memoryPathText through
// src/memory/db/session.ts): the harness and model of a subharness path, `direct` without one.
// The path is the first route of the memory chain. The status rows of `/subharness status` are tested with the
// subharness commands.
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { memoryPath, memoryPathText } from '../../../src/subharness/memory-path.ts';
import { CONFIG_DIR, CONFIG_FILE } from '../../../src/config/files.ts';
import { tempDir } from '../../fixtures/tmp.ts';

/** A private layer whose config.json names `route` as the only route of the memory role. */
function layerWithMemoryRoute(route: Record<string, unknown>): string {
  const dir = tempDir('nep-memory-path-');
  fs.mkdirSync(path.join(dir, CONFIG_DIR), { recursive: true });
  fs.writeFileSync(
    path.join(dir, CONFIG_DIR, CONFIG_FILE),
    JSON.stringify({ models: { routes: { memory: [route] } } })
  );
  return dir;
}

test('a memory route at disabled has no effort on claude and low on codex', () => {
  // Catches: the memory path of a claude route at `disabled` carrying `low`, so the writer runs it with `--effort low`.
  for (const [backend, effort] of [
    ['claude', null],
    ['codex', 'low'],
  ] as const) {
    const dir = layerWithMemoryRoute({ via: 'harness', backend, model: 'm', effort: 'disabled' });
    const found = memoryPath(dir);
    assert.equal(found.kind, 'subharness');
    assert.equal(found.kind === 'subharness' ? found.effort : 'direct', effort, backend);
  }
});

// The routes are named by what runs them (brief 2026-11-06 "the routes are named by what runs them"): `direct-api` for
// the OpenRouter API, `claude-harness`, `codex-harness` and `opencode-harness` for the three CLIs. The owner reads and
// types these four names; keys.json keeps `backend: "claude"` and the rest. The mapping lives in
// src/subharness/route-names.ts and is applied at the edge: the status rows, the answers of `/model set` and the
// `--via` value. keys.json lives in a temp dir; the backend runner and fetch are fakes.

test('the route in words names the harness, and direct-api for the API', () => {
  // Catches: the setup line and the script line printing the stored word the owner is told not to type.
  // Changed: the core's path and the memory writer's share one text (slice 4), so this reads `memoryPathText`.
  const text = memoryPathText({ kind: 'subharness', backend: 'claude', model: 'claude-opus-4-6', effort: 'low' });
  assert.equal(text, 'via claude-harness claude-opus-4-6 effort low');
  assert.equal(memoryPathText({ kind: 'direct' }), 'direct-api');
});
