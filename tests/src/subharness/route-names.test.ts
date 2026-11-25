// The routes are named by what runs them (brief 2026-11-06 "the routes are named by what runs them"): `direct-api` for
// the OpenRouter API, `claude-harness`, `codex-harness` and `opencode-harness` for the three CLIs. The owner reads and
// types these four names; keys.json keeps `backend: "claude"` and the rest. The mapping lives in
// src/subharness/route-names.ts and is applied at the edge: the status rows, the answers of `/model set` and the
// `--via` value. keys.json lives in a temp dir; the backend runner and fetch are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_NAMES, backendOfRouteName, routeName } from '../../../src/subharness/route-names.ts';

type Route = 'api' | 'claude' | 'codex' | 'opencode';
const ROUTES: ReadonlyArray<Route> = ['api', 'claude', 'codex', 'opencode'];
const FOUR_NAMES = ['direct-api', 'claude-harness', 'codex-harness', 'opencode-harness'];

// the mapping

test('routeName and backendOfRouteName are inverse for the four routes', () => {
  // Catches: a name that renders but cannot be typed back, so the owner copies `via claude-harness` and is refused.
  assert.deepEqual(
    ROUTES.map((backend) => routeName(backend)),
    FOUR_NAMES
  );
  for (const backend of ROUTES) assert.equal(backendOfRouteName(routeName(backend)), backend);
  assert.deepEqual(ROUTE_NAMES, {
    api: 'direct-api',
    claude: 'claude-harness',
    codex: 'codex-harness',
    opencode: 'opencode-harness',
  });
});
