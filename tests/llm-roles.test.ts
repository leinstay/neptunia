// Tests for the on and off state of the optional model roles (src/llm/roles.ts#roleOn and #offRoles, the
// `no-model` answer of src/llm/role-health.ts, config/config.json and src/config/schema/models.ts). `vision`,
// `video`, `drawing` and `speech` are on when `models.base.<role>` holds a model and off when it is null, the
// tracked default; `core`, `memory`, `analyzer` and `embedding` are mandatory. The other tests of the roles are in
// tests/roles.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANDATORY_ROLES, OPTIONAL_ROLES, ROLE_DEFAULTS, offRoles, roleModel, roleOn } from '../src/llm/roles.ts';
import { createRoleHealth } from '../src/llm/role-health.ts';
import { checkConfig } from '../src/config/check.ts';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';
import { readConfig } from '../src/config.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The tracked config.json with `local` merged over it, as the core reads a deployment. */
function loadWith(local: unknown) {
  const dir = tempDir('nep-roles-off-');
  try {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'config', 'config.json'), path.join(dir, 'config', 'config.json'));
    if (local !== undefined) fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify(local));
    return readConfig(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const withBase = (base: Record<string, unknown>) => ({ models: { base } });

// Bug caught: a null model read as "the role's default" would call a model nobody chose, and spend on it.
test('an optional role whose model is null, false or empty is off, one with a model id is on', () => {
  for (const role of OPTIONAL_ROLES) {
    assert.equal(roleOn(withBase({ [role]: null }), role), false, `${role} null`);
    assert.equal(roleOn(withBase({ [role]: false }), role), false, `${role} false`);
    assert.equal(roleOn(withBase({ [role]: '' }), role), false, `${role} empty`);
    assert.equal(roleOn(withBase({ [role]: 'x/model' }), role), true, `${role} with a model`);
  }
});

// Bug caught: a fixture or an older config without the key turning every role off, which changes her request.
test('an optional role whose key is absent is on with its built-in default', () => {
  for (const role of OPTIONAL_ROLES) {
    assert.equal(roleOn({}, role), true, role);
    assert.equal(roleOn(withBase({}), role), true, role);
    assert.equal(roleModel(withBase({}), role), ROLE_DEFAULTS[role]);
  }
});

// Bug caught: a mandatory role switched off by a null would leave the persona without a core or a memory.
test('the mandatory roles are on whatever their key holds', () => {
  assert.deepEqual([...MANDATORY_ROLES], ['core', 'memory', 'analyzer', 'embedding']);
  for (const role of MANDATORY_ROLES) {
    assert.equal(roleOn(withBase({ [role]: null }), role), true, `${role} null`);
    assert.equal(roleOn(withBase({ [role]: false }), role), true, `${role} false`);
  }
});

// Bug caught: the senses line and the tool list naming the off roles in an order that moves with the config.
test('offRoles lists the off optional roles in the order vision, video, drawing, speech', () => {
  assert.deepEqual([...OPTIONAL_ROLES], ['vision', 'video', 'drawing', 'speech']);
  const config = withBase({ speech: null, vision: null, video: 'x/v', drawing: false });
  assert.deepEqual(offRoles(config), ['vision', 'drawing', 'speech']);
  assert.deepEqual(offRoles(withBase({ vision: 'a', video: 'b', drawing: 'c', speech: 'd' })), []);
});

// Bug caught: a request built on an off role's default model because the resolver fell back to ROLE_DEFAULTS.
test('roleModel gives no model for an off optional role and the id for an on one', () => {
  assert.equal(roleModel(withBase({ drawing: null }), 'drawing'), undefined);
  assert.equal(roleModel(withBase({ vision: false }), 'vision'), undefined);
  assert.equal(roleModel(withBase({ vision: 'x/v' }), 'vision'), 'x/v');
  assert.equal(roleModel(withBase({ core: null }), 'core'), ROLE_DEFAULTS.core, 'a mandatory role keeps its default');
});

// Bug caught: an off role passing the health check and so being routed as if it were up.
test('role health says no-model for an optional role whose model is null', () => {
  const health = createRoleHealth({ now: () => 0, hasKey: () => true });
  for (const role of OPTIONAL_ROLES) {
    assert.deepEqual(health.down(withBase({ [role]: null }), role), { role, reason: 'no-model', retryAt: null });
  }
  assert.equal(health.down(withBase({ vision: 'x/v' }), 'vision'), null);
});

// Bug caught: the tracked config still shipping models for the optional roles, so a fresh install spends on them.
test('the tracked config has a model for the four mandatory roles and none for the four optional ones', () => {
  const config = loadWith(undefined);
  assert.deepEqual(offRoles(config), ['vision', 'video', 'drawing', 'speech']);
  for (const role of MANDATORY_ROLES) {
    const model = roleModel(config, role);
    assert.ok(typeof model === 'string' && model.length > 0, `${role} has a model`);
  }
  for (const role of OPTIONAL_ROLES) {
    const key = CONFIG_SCHEMA.find((entry) => entry.key === `models.base.${role}`);
    assert.equal(key?.default, null, `${role} schema default`);
  }
});

// Bug caught: `model set` writing a model that a still-null tracked key or a stale flag keeps off.
test('a local models.base.<role> id over the tracked null turns that role on and leaves the others off', () => {
  const config = loadWith(withBase({ drawing: 'openai/gpt-image-x' }));
  assert.equal(roleOn(config, 'drawing'), true);
  assert.equal(roleModel(config, 'drawing'), 'openai/gpt-image-x');
  assert.deepEqual(offRoles(config), ['vision', 'video', 'speech']);
});

// Bug caught: the install accepting a null for the core, the memory, the analyzer or the embedding model.
test('the schema refuses a null model for a mandatory role and accepts one for an optional role', () => {
  for (const role of MANDATORY_ROLES) {
    assert.deepEqual(
      checkConfig(withBase({ [role]: null }), CONFIG_SCHEMA),
      [{ key: `models.base.${role}`, kind: 'type' }],
      role
    );
    assert.deepEqual(checkConfig(withBase({ [role]: 'x/model' }), CONFIG_SCHEMA), [], `${role} with a model`);
  }
  for (const role of OPTIONAL_ROLES) {
    assert.deepEqual(checkConfig(withBase({ [role]: null }), CONFIG_SCHEMA), [], `${role} null`);
    assert.deepEqual(checkConfig(withBase({ [role]: 'x/model' }), CONFIG_SCHEMA), [], `${role} with a model`);
  }
});
