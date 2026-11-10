// Tests for the purposes the analyzer answers (src/llm/roles.ts#PURPOSE_ROLES, as
// src/memory/db/writer-switch.ts#effectiveModels resolves each purpose to its role and model): a purpose no request sends
// (`room`, `rewatch`) resolves to no role, and the two search purposes (`search-summary`, `quick-search`, which go out on
// the role `search`) never resolve to the analyzer. That every purpose a request sends keeps its role is checked over
// the call sites in tests/roles.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveModels } from '../src/memory/db/writer-switch.ts';
import { chainsOf } from './fixtures/chains.ts';

const CONFIG = { models: { routes: chainsOf({ analyzer: 'x/analyzer', core: 'x/core' }) } };

/** The role each purpose resolves to, as the effective-models list gives it. */
function rolesByPurpose(): Map<string, Array<string>> {
  const roles = new Map<string, Array<string>>();
  for (const { purpose, role } of effectiveModels(CONFIG, null))
    roles.set(purpose, [...(roles.get(purpose) ?? []), role]);
  return roles;
}

test('the search purposes never resolve to the analyzer', () => {
  // Bug: a search summary is listed on the analyzer's model and key while it goes out on the search model.
  const roles = rolesByPurpose();
  for (const purpose of ['search-summary', 'quick-search']) {
    assert.equal((roles.get(purpose) ?? []).includes('analyzer'), false, purpose);
  }
});
