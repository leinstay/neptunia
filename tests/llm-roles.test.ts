// Tests for the on and off state of the optional model roles (src/llm/roles.ts#roleOn and #offRoles, the
// `no-model` answer of src/llm/role-health.ts and config/config.json). `vision`, `video`, `drawing` and `speech` are on
// while their chain in `models.routes` holds a route and off with none, the tracked default; `core`, `memory`,
// `analyzer` and `embedding` are mandatory. The other tests of the roles are in tests/roles.test.ts.
// Changed: `models.base` is retired (spec 2026-11-09-model-routes, slice 4), so a role is on by its chain; the tests of
// an absent `models.base` key and of the schema's `models.base` types are deleted with the setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANDATORY_ROLES, OPTIONAL_ROLES, ROLE_DEFAULTS, offRoles, roleModel, roleOn } from '../src/llm/roles.ts';
import { createRoleHealth } from '../src/llm/role-health.ts';
import { readConfig } from '../src/config.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The tracked config.json with `local` merged over it, as the core reads a deployment. */
function loadWith(local: unknown) {
  const dir = tempDir('nep-roles-off-');
  try {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'config', 'config.json'), path.join(dir, 'config', 'config.json'));
    // Role overrides use the canonical persona file.
    fs.mkdirSync(path.join(dir, 'data', 'config'), { recursive: true });
    if (local !== undefined) fs.writeFileSync(path.join(dir, 'data', 'config', 'config.json'), JSON.stringify(local));
    return readConfig(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** `models.routes` with one API route per role named with a model, and an empty chain for one named with null. */
const withChains = (models: Record<string, string | null>) => ({
  models: {
    routes: Object.fromEntries(
      Object.entries(models).map(([role, model]) => [
        role,
        model === null ? [] : [{ via: 'api', key: 'main', model, effort: null }],
      ])
    ),
  },
});

// Bug caught: an empty chain read as "the role's default" would call a model nobody chose, and spend on it.
test('an optional role whose chain is empty or absent is off, one with a route is on', () => {
  for (const role of OPTIONAL_ROLES) {
    assert.equal(roleOn(withChains({ [role]: null }), role), false, `${role} empty`);
    assert.equal(roleOn({}, role), false, `${role} absent`);
    assert.equal(roleOn(withChains({ [role]: 'x/model' }), role), true, `${role} with a route`);
  }
});

// Bug caught: a mandatory role switched off by an empty chain would leave the persona without a core or a memory.
test('the mandatory roles are on whatever their chain holds', () => {
  assert.deepEqual([...MANDATORY_ROLES], ['core', 'memory', 'analyzer', 'embedding']);
  for (const role of MANDATORY_ROLES) {
    assert.equal(roleOn(withChains({ [role]: null }), role), true, `${role} empty`);
    assert.equal(roleOn({}, role), true, `${role} absent`);
  }
});

// Bug caught: the senses line and the tool list naming the off roles in an order that moves with the config.
test('offRoles lists the off optional roles in the order vision, video, drawing, speech', () => {
  assert.deepEqual([...OPTIONAL_ROLES], ['vision', 'video', 'drawing', 'speech']);
  const config = withChains({ speech: null, vision: null, video: 'x/v' });
  assert.deepEqual(offRoles(config), ['vision', 'drawing', 'speech']);
  assert.deepEqual(offRoles(withChains({ vision: 'a', video: 'b', drawing: 'c', speech: 'd' })), []);
});

// Bug caught: a request built on an off role's default model because the resolver fell back to ROLE_DEFAULTS.
test('roleModel gives no model for an off optional role and the id for an on one', () => {
  assert.equal(roleModel(withChains({ drawing: null }), 'drawing'), undefined);
  assert.equal(roleModel(withChains({ vision: 'x/v' }), 'vision'), 'x/v');
  assert.equal(roleModel(withChains({ core: null }), 'core'), ROLE_DEFAULTS.core, 'a mandatory role keeps its default');
});

// Bug caught: an off role passing the health check and so being routed as if it were up.
test('role health says no-model for an optional role whose chain is empty', () => {
  const health = createRoleHealth({ now: () => 0, hasKey: () => true });
  for (const role of OPTIONAL_ROLES) {
    assert.deepEqual(health.down(withChains({ [role]: null }), role), { role, reason: 'no-model', retryAt: null });
  }
  assert.equal(health.down(withChains({ vision: 'x/v' }), 'vision'), null);
});

// Bug caught: the tracked config shipping a chain for an optional role, so a fresh install spends on it.
test('the tracked config leaves the four optional roles off and the four mandatory ones on their defaults', () => {
  const config = loadWith(undefined);
  assert.deepEqual(offRoles(config), ['vision', 'video', 'drawing', 'speech']);
  for (const role of MANDATORY_ROLES) {
    const model = roleModel(config, role);
    assert.ok(typeof model === 'string' && model.length > 0, `${role} has a model`);
  }
});

// Bug caught: `/model set` writing a chain that the tracked settings still keep off.
test('a local chain over the tracked config turns that role on and leaves the others off', () => {
  const config = loadWith(withChains({ drawing: 'openai/gpt-image-x' }));
  assert.equal(roleOn(config, 'drawing'), true);
  assert.equal(roleModel(config, 'drawing'), 'openai/gpt-image-x');
  assert.deepEqual(offRoles(config), ['vision', 'video', 'speech']);
});
