// Tests for src/llm/roles.js (the model roles in three groups: `models.base` for the core, its
// helpers and drawing, `models.errands` for the errand agents, `models.development` for the
// development agents; one resolver, no cross-role fallback), src/config.js#readConfig and the call sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_ROLES,
  CORE_ROLE,
  CORE_ROLES,
  DEVELOPMENT_ROLES,
  ERRAND_ROLES,
  NON_CORE_ROLES,
  MEMORY_ROLE,
  OPENCODE_ROLES,
  ROLES,
  ROLE_DEFAULTS,
  PURPOSE_ROLES,
  isRole,
  roleConfigKeys,
  roleGroup,
  roleModel,
} from '../src/llm/roles.js';
import { readConfig } from '../src/config.js';
import { MODEL_SET_ROLES } from '../src/tools/impl/catalog.ts';
import { tempDir } from './fixtures/tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A scratch root with the tracked config.json and, when given, a config.local.json. */
function loadWith(local) {
  const dir = tempDir('nep-roles-');
  try {
    // PR 7c: the tracked settings live in config/config.json.
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'config', 'config.json'), path.join(dir, 'config', 'config.json'));
    if (local !== undefined) fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify(local));
    return readConfig(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- roleModel ---------------------------------------------------------------

test("roleModel: models.byPurpose for the purpose, else the role's own key, else the role default", () => {
  const config = { models: { base: { analyzer: 'x/analyzer' }, byPurpose: { split: 'x/split' } } };
  assert.equal(roleModel(config, 'analyzer', 'split'), 'x/split');
  assert.equal(roleModel(config, 'analyzer', 'address'), 'x/analyzer');
  assert.equal(roleModel(config, 'analyzer'), 'x/analyzer');
  assert.equal(roleModel(config, 'analyzer', 'lookup'), 'x/analyzer', 'a lookup purpose goes out on the analyzer');
});

test('roles: the lookup purposes go out on the analyzer, each pinnable by itself', () => {
  for (const purpose of [
    'lookup',
    'planner',
    'recall-summary',
    'search-summary',
    'read-link',
    'diary-plan',
    'web-search',
  ]) {
    assert.equal(PURPOSE_ROLES[purpose], 'analyzer', purpose);
    assert.equal(
      roleModel({ models: { base: { analyzer: 'x/a' }, byPurpose: { [purpose]: 'x/pinned' } } }, 'analyzer', purpose),
      'x/pinned',
      purpose
    );
  }
});

test('roleModel: a byPurpose entry applies whatever the role, an empty or non-string one does not', () => {
  const config = { models: { base: { core: 'x/core' }, byPurpose: { reply: 'x/reply', describe: '', relook: 7 } } };
  assert.equal(roleModel(config, 'core', 'reply'), 'x/reply');
  assert.equal(roleModel(config, 'vision', 'describe'), ROLE_DEFAULTS.vision);
  assert.equal(roleModel(config, 'vision', 'relook'), ROLE_DEFAULTS.vision);
  assert.equal(
    roleModel({ models: { byPurpose: Object.create({ split: 'x/inherited' }) } }, 'analyzer', 'split'),
    ROLE_DEFAULTS.analyzer
  );
});

test('roleModel: a byPurpose that is not a plain object, or an entry that is not a non-empty string, leaves the role model', () => {
  const base = { analyzer: 'x/analyzer' };
  for (const byPurpose of [{ lookup: '' }, { lookup: null }, { lookup: 7 }, ['x/array'], 'x/string', null]) {
    assert.equal(
      roleModel({ models: { base, byPurpose } }, 'analyzer', 'lookup'),
      'x/analyzer',
      JSON.stringify(byPurpose)
    );
  }
  assert.equal(
    roleModel({ models: { byPurpose: { toString: 'x/proto' } } }, 'analyzer', 'constructor'),
    ROLE_DEFAULTS.analyzer,
    'own keys only'
  );
});

test("roleModel: an unset role takes its own default, never another role's model", () => {
  const config = { models: { base: { core: 'x/core', analyzer: 'x/analyzer', vision: 'x/vision' } } };
  for (const role of ['video', 'embedding', 'drawing', 'scout', 'dev']) {
    assert.equal(roleModel(config, role), ROLE_DEFAULTS[role], role);
  }
  assert.equal(roleModel({ models: { base: { analyzer: null, video: '' } } }, 'analyzer'), ROLE_DEFAULTS.analyzer);
  assert.equal(roleModel({ models: { base: { analyzer: null, video: '' } } }, 'video'), ROLE_DEFAULTS.video);
  assert.equal(roleModel(undefined, 'core'), ROLE_DEFAULTS.core);
  assert.equal(
    roleModel({ models: { base: { core: { nested: 'x/no' } } } }, 'core'),
    ROLE_DEFAULTS.core,
    'models.base.core is a string, nothing else'
  );
});

test('roleModel: undefined for a name that is not a role, unless its purpose is pinned', () => {
  assert.equal(roleModel({}, 'constructor'), undefined);
  assert.equal(roleModel({}, 'web'), undefined, 'the errand agent is called scout');
  assert.equal(roleModel({ models: { byPurpose: { odd: 'x/odd' } } }, 'nope', 'odd'), 'x/odd');
  assert.equal(isRole('core'), true);
  assert.equal(isRole('scout'), true);
  assert.equal(isRole('web'), false);
  assert.equal(isRole('byPurpose'), false);
});

test('roleModel: each role reads its own group only', () => {
  const crossed = {
    models: {
      base: { scout: 'openrouter/x/scout', thinker: 'openrouter/x/thinker' },
      errands: { core: 'x/core', drawing: 'x/draw' },
      development: { analyzer: 'x/an', server: 'openrouter/x/server' },
    },
  };
  for (const role of ROLES) assert.equal(roleModel(crossed, role), ROLE_DEFAULTS[role], role);
  const own = {
    models: {
      base: { drawing: 'x/draw' },
      errands: { scout: 'openrouter/x/scout' },
      development: { dev: 'openrouter/x/dev' },
    },
  };
  assert.equal(roleModel(own, 'drawing'), 'x/draw');
  assert.equal(roleModel(own, 'scout'), 'openrouter/x/scout');
  assert.equal(roleModel(own, 'dev'), 'openrouter/x/dev');
  assert.equal(roleModel(own, 'server'), ROLE_DEFAULTS.server, "never another agent role's model");
  for (const models of [null, 'x', ['a'], { base: 7 }, { base: [], errands: 'x', development: null }])
    assert.equal(roleModel({ models }, 'core'), ROLE_DEFAULTS.core, JSON.stringify(models));
});

test("roleModel: the memory role has its own key and default, never the core's key", () => {
  assert.equal(roleModel({ models: { base: { memory: 'x/m', core: 'x/c' } } }, MEMORY_ROLE), 'x/m');
  assert.equal(
    roleModel({ models: { base: { core: 'x/c' } } }, MEMORY_ROLE),
    ROLE_DEFAULTS.core,
    'unset: its own default, never the core key'
  );
  assert.equal(isRole(MEMORY_ROLE), false, '/nep model does not list it');
});

test("roleGroup / roleConfigKeys: each role's group and config keys", () => {
  for (const role of [...BASE_ROLES, MEMORY_ROLE]) {
    assert.equal(roleGroup(role), 'base', role);
    assert.deepEqual(roleConfigKeys(role), ['models', 'base', role]);
  }
  for (const role of ERRAND_ROLES) {
    assert.equal(roleGroup(role), 'errands', role);
    assert.deepEqual(roleConfigKeys(role), ['models', 'errands', role]);
  }
  for (const role of DEVELOPMENT_ROLES) {
    assert.equal(roleGroup(role), 'development', role);
    assert.deepEqual(roleConfigKeys(role), ['models', 'development', role]);
  }
  for (const name of ['byPurpose', 'web', 'voice', 'agents', 'helpers', 'base', undefined]) {
    assert.equal(roleGroup(name), undefined, String(name));
    assert.equal(roleConfigKeys(name), undefined, String(name));
  }
});

test("roles: the built-in defaults equal config.json's three groups, and every role has one", () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
  // `abilities` declares what each model can do, per model id (PR E in detail, stage 4 cut spec).
  assert.deepEqual(Object.keys(shipped.models), ['base', 'byPurpose', 'abilities', 'errands', 'development']);
  assert.deepEqual(Object.keys(shipped.models.base), [CORE_ROLE, MEMORY_ROLE, ...NON_CORE_ROLES, 'drawing']);
  assert.deepEqual(Object.keys(shipped.models.errands), [...ERRAND_ROLES]);
  assert.deepEqual(Object.keys(shipped.models.development), [...DEVELOPMENT_ROLES]);
  assert.equal(
    shipped.models.base.memory,
    shipped.models.base.core,
    "her memory session starts on the core's model, as its own key"
  );
  assert.equal(
    roleModel({}, 'memory'),
    roleModel({}, 'core'),
    "unset: the built-in default of the memory role is the core's default"
  );
  const { memory, ...base } = shipped.models.base;
  assert.deepEqual({ ...base, ...shipped.models.errands, ...shipped.models.development }, { ...ROLE_DEFAULTS });
  assert.deepEqual(shipped.models.byPurpose, {});
  assert.deepEqual(Object.keys(ROLE_DEFAULTS).sort(), [...ROLES].sort());
  assert.deepEqual([...ROLES], [...CORE_ROLES, 'drawing', ...ERRAND_ROLES, ...DEVELOPMENT_ROLES]);
  assert.deepEqual([...MODEL_SET_ROLES], [...ROLES], '/nep model set offers every role');
  for (const role of Object.values(PURPOSE_ROLES)) assert.ok(isRole(role), role);
});

test('roles: the groups, the OpenCode roles with OpenCode model ids, resolved like any role, no purpose on them', () => {
  assert.equal(CORE_ROLE, 'core');
  assert.deepEqual([...NON_CORE_ROLES], ['analyzer', 'vision', 'video', 'embedding', 'speech']);
  assert.deepEqual([...CORE_ROLES], ['core', 'analyzer', 'vision', 'video', 'embedding', 'speech']);
  assert.deepEqual([...BASE_ROLES], ['core', 'analyzer', 'vision', 'video', 'embedding', 'speech', 'drawing']);
  assert.deepEqual([...ERRAND_ROLES], ['scout', 'server']);
  assert.deepEqual([...DEVELOPMENT_ROLES], ['thinker', 'dev']);
  assert.deepEqual([...OPENCODE_ROLES], ['scout', 'server', 'thinker', 'dev']);
  assert.equal(ROLE_DEFAULTS.scout, 'openrouter/openai/gpt-6.1-sol');
  assert.equal(ROLE_DEFAULTS.server, 'openrouter/openai/gpt-6.1-sol');
  assert.equal(ROLE_DEFAULTS.thinker, 'openrouter/anthropic/claude-opus-5.5');
  assert.equal(ROLE_DEFAULTS.dev, 'openrouter/anthropic/claude-sonnet-5.5');
  assert.equal(ROLE_DEFAULTS.drawing, 'openai/gpt-image-2.5-flare', 'drawing: a bare OpenRouter image model id');
  for (const role of OPENCODE_ROLES)
    assert.match(ROLE_DEFAULTS[role], /^openrouter\/[\w.-]+\/[\w.:-]+$/, `${role}: an OpenCode id, provider first`);
  for (const role of ROLES) assert.equal(roleModel({}, role), ROLE_DEFAULTS[role], role);
  assert.equal(roleModel({ models: { errands: { scout: 'openrouter/x/scout' } } }, 'scout'), 'openrouter/x/scout');
  assert.equal(
    roleModel({ models: { errands: { scout: 'openrouter/x/scout' }, byPurpose: { scout: 'x/pinned' } } }, 'server'),
    ROLE_DEFAULTS.server
  );
  assert.ok(
    !Object.values(PURPOSE_ROLES).some((role) => OPENCODE_ROLES.includes(role)),
    'no request purpose goes out on an OpenCode role'
  );
});

test('roles: config.json carries none of the old model keys', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
  assert.equal(shipped.classifier, undefined);
  assert.equal(Object.hasOwn(shipped, 'roles'), false);
  assert.equal(Object.hasOwn(shipped.llm, 'model'), false);
  assert.equal(Object.hasOwn(shipped.memory, 'model'), false);
  assert.equal(Object.hasOwn(shipped.image, 'model'), false);
  assert.deepEqual(shipped.llm.hedge.roles, ['analyzer']);
  assert.deepEqual(shipped.llm.cache.roles, ['core']);
  assert.equal(
    JSON.stringify([shipped.models, shipped.llm]).includes('voice'),
    false,
    'no model key or role named voice (memory.voice is the memory-wording section, not a role)'
  );
  assert.equal(
    JSON.stringify([shipped.models, shipped.llm, shipped.agents]).includes('"web"'),
    false,
    'the errand agent is called scout'
  );
});

// ---- readConfig --------------------------------------------------------------

test('readConfig: config.local.json is merged over config.json key by key', () => {
  const config = loadWith({ models: { base: { vision: 'x/v' } } });
  assert.equal(roleModel(config, 'vision'), 'x/v');
  assert.equal(roleModel(config, 'core'), ROLE_DEFAULTS.core);
  assert.equal(roleModel(loadWith(undefined), 'vision'), ROLE_DEFAULTS.vision);
});

// ---- every purpose resolves --------------------------------------------------

test("purposes: under config.json every purpose resolves to its role's default model", () => {
  const config = loadWith(undefined);
  for (const [purpose, role] of Object.entries(PURPOSE_ROLES))
    assert.equal(roleModel(config, role, purpose), ROLE_DEFAULTS[role], purpose);
});

// ---- the call sites ----------------------------------------------------------

/** Every .js/.mjs file under src/ and tools/, as [relative path, text]. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.m?js$/.test(name)) out.push([path.relative(ROOT, full), fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'tools'));
  return out;
}

test('call sites: every request role is one of the roles, every purpose goes out on its own role', () => {
  const chatRoles = new Set(['system', 'user', 'assistant', 'tool']);
  let pairs = 0;
  for (const [file, text] of sources()) {
    for (const [, role] of text.matchAll(/\brole: '([\w.-]+)'/g)) {
      if (!chatRoles.has(role)) assert.ok(isRole(role), `${file}: role '${role}'`);
      assert.ok(
        !OPENCODE_ROLES.includes(role),
        `${file}: no request of the bot goes out on the OpenCode role '${role}'`
      );
    }
    for (const [, role, purpose] of text.matchAll(/roleModel\([\w.]+, '([\w-]+)', '([\w-]+)'\)/g)) {
      assert.equal(PURPOSE_ROLES[purpose], role, `${file}: roleModel for ${purpose}`);
      pairs += 1;
    }
    for (const [, role, purpose] of text.matchAll(
      /roleRequestOptions\([\w.]+, \{\s*role: '([\w-]+)'[^}]*?purpose: '([\w-]+)'/g
    )) {
      assert.equal(PURPOSE_ROLES[purpose], role, `${file}: helper request for ${purpose}`);
      pairs += 1;
    }
  }
  assert.ok(pairs >= 30, `found ${pairs} role/purpose pairs`);
});
