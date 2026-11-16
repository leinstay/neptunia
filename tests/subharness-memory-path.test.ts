// The memory writer's path as the memory status line names it (src/subharness/memory-path.ts#memoryPathText through
// src/memory/db/session.ts): the harness and model of a subharness path, `direct` without one.
// Changed: the path is the first route of the memory chain (spec 2026-11-09-model-routes, slice 4), so the tests of
// `model set memory --via`, of the stored record and of clearing it are deleted with `models.harness`; the status rows of
// `/subharness status` are tested in tests/commands-subharness.test.ts.
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { memoryPath } from '../src/subharness/memory-path.ts';
import { CONFIG_DIR, CONFIG_FILE } from '../src/config/files.ts';
import { tempDir } from './fixtures/tmp.ts';

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
