// Tests for src/llm/roles.ts (the model roles in three groups: the core, its helpers and drawing on the first route of
// their chains in `models.routes`, `models.errands` for the errand agents, `models.development` for the development
// agents; one resolver, no cross-role fallback), src/config.ts#readConfig and the call sites.
// Changed: `models.base` is retired (spec 2026-11-09-model-routes, slice 4), so a base role's model comes from its chain.
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
  roleOn,
  searchModel,
  MANDATORY_ROLES,
  OPTIONAL_ROLES,
  offRoles,
} from '../src/llm/roles.ts';
import { readConfig } from '../src/config.ts';
import { MODEL_SET_ROLES } from '../src/tools/operations/catalog.ts';
import { tempDir } from './fixtures/tmp.ts';
import { createRoleHealth } from '../src/llm/role-health.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const purposeRoles: Record<string, string> = PURPOSE_ROLES;

/** A chain of one API route on the key `main` for `role`, as `models.routes` holds it. */
const on = (role: string, model: string) => ({ [role]: [{ via: 'api', key: 'main', model, effort: null }] });

/** A scratch root with the tracked config.json and, when given, a config.local.json. */
function loadWith(local: unknown) {
  const dir = tempDir('nep-roles-');
  try {
    // PR 7c: the tracked settings live in config/config.json.
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

// ---- roleModel ---------------------------------------------------------------

test("roleModel: models.byPurpose for the purpose, else the role's first route, else the role default", () => {
  const config = { models: { routes: on('analyzer', 'x/analyzer'), byPurpose: { split: 'x/split' } } };
  assert.equal(roleModel(config, 'analyzer', 'split'), 'x/split');
  assert.equal(roleModel(config, 'analyzer', 'address'), 'x/analyzer');
  assert.equal(roleModel(config, 'analyzer'), 'x/analyzer');
  assert.equal(roleModel(config, 'analyzer', 'lookup'), 'x/analyzer', 'a lookup purpose goes out on the analyzer');
});

test('roles: the lookup purposes go out on the analyzer, each pinnable by itself', () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  for (const purpose of ['recall-summary', 'selfreflection-planner', 'web-search']) {
    assert.equal(purposeRoles[purpose], 'analyzer', purpose);
    assert.equal(
      roleModel(
        { models: { routes: on('analyzer', 'x/a'), byPurpose: { [purpose]: 'x/pinned' } } },
        'analyzer',
        purpose
      ),
      'x/pinned',
      purpose
    );
  }
});

test('roleModel: a byPurpose entry applies whatever the role, an empty or non-string one does not', () => {
  const routes = { ...on('core', 'x/core'), ...on('vision', 'x/vision') };
  const config = { models: { routes, byPurpose: { reply: 'x/reply', describe: '', relook: 7 } } };
  assert.equal(roleModel(config, 'core', 'reply'), 'x/reply');
  assert.equal(roleModel(config, 'vision', 'describe'), 'x/vision');
  assert.equal(roleModel(config, 'vision', 'relook'), 'x/vision');
  assert.equal(
    roleModel({ models: { byPurpose: Object.create({ split: 'x/inherited' }) } }, 'analyzer', 'split'),
    ROLE_DEFAULTS.analyzer
  );
});

test('roleModel: a byPurpose that is not a plain object, or an entry that is not a non-empty string, leaves the role model', () => {
  const routes = on('analyzer', 'x/analyzer');
  for (const byPurpose of [{ lookup: '' }, { lookup: null }, { lookup: 7 }, ['x/array'], 'x/string', null]) {
    assert.equal(
      roleModel({ models: { routes, byPurpose } }, 'analyzer', 'lookup'),
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

test("roleModel: a mandatory role with no chain takes its own default, never another role's model", () => {
  const config = { models: { routes: { ...on('core', 'x/core'), ...on('analyzer', 'x/analyzer') } } };
  for (const role of ['embedding', 'memory', 'scout', 'dev'])
    assert.equal(roleModel(config, role), ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS.core, role);
  assert.equal(roleModel(undefined, 'core'), ROLE_DEFAULTS.core);
  assert.equal(roleModel({ models: { routes: { analyzer: [] } } }, 'analyzer'), ROLE_DEFAULTS.analyzer);
});

test('roleModel: an optional role with no chain, or an empty one, is off', () => {
  // Catches: an optional role with no chain coming back on its built-in default, so it spends a key nobody chose.
  for (const role of ['vision', 'video', 'speech', 'drawing']) {
    assert.equal(roleModel({}, role), undefined, role);
    assert.equal(roleModel({ models: { routes: { [role]: [] } } }, role), undefined, role);
    assert.equal(roleOn({}, role), false, role);
  }
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
      routes: { scout: [{ via: 'api', key: 'main', model: 'openrouter/x/scout' }] },
      errands: { core: 'x/core', drawing: 'x/draw' },
      development: { analyzer: 'x/an', server: 'openrouter/x/server' },
    },
  };
  for (const role of ['core', 'analyzer', 'scout', 'server'])
    assert.equal(roleModel(crossed, role), ROLE_DEFAULTS[role], role);
  assert.equal(roleModel(crossed, 'drawing'), undefined, 'an optional role named in another group stays off');
  const own = {
    models: {
      routes: on('drawing', 'x/draw'),
      errands: { scout: 'openrouter/x/scout' },
      development: { dev: 'openrouter/x/dev' },
    },
  };
  assert.equal(roleModel(own, 'drawing'), 'x/draw');
  assert.equal(roleModel(own, 'scout'), 'openrouter/x/scout');
  assert.equal(roleModel(own, 'dev'), 'openrouter/x/dev');
  assert.equal(roleModel(own, 'server'), ROLE_DEFAULTS.server, "never another agent role's model");
  for (const models of [null, 'x', ['a'], { routes: 7 }, { routes: [], errands: 'x', development: null }])
    assert.equal(roleModel({ models }, 'core'), ROLE_DEFAULTS.core, JSON.stringify(models));
});

test("roleModel: the memory role has its own chain and default, never the core's chain", () => {
  assert.equal(roleModel({ models: { routes: { ...on('memory', 'x/m'), ...on('core', 'x/c') } } }, MEMORY_ROLE), 'x/m');
  assert.equal(
    roleModel({ models: { routes: on('core', 'x/c') } }, MEMORY_ROLE),
    ROLE_DEFAULTS.core,
    "with no chain: its own default, never the core's route"
  );
  assert.equal(isRole(MEMORY_ROLE), false, '/nep model does not list it');
});

test("roleGroup / roleConfigKeys: each role's group, and the config keys of an agent's model", () => {
  // Changed: a base role's model is the first route of its chain, so it has no config key of its own (slice 4).
  for (const role of [...BASE_ROLES, MEMORY_ROLE]) {
    assert.equal(roleGroup(role), 'base', role);
    assert.equal(roleConfigKeys(role), undefined, role);
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

test("roles: the built-in defaults equal config.json's agent groups, and every role has one", () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
  // `abilities` declares what each model can do, per model id (PR E in detail, stage 4 cut spec).
  // Changed: `agents` holds the agents' routing; `routes` holds each role's chain of routes, empty as shipped, and
  // replaces `base` and `harness` (spec 2026-11-09-model-routes, slice 4).
  assert.deepEqual(Object.keys(shipped.models), [
    'byPurpose',
    'abilities',
    'errands',
    'development',
    'agents',
    'routes',
  ]);
  assert.deepEqual(shipped.models.routes, {});
  assert.deepEqual(Object.keys(shipped.models.errands), [...ERRAND_ROLES]);
  assert.deepEqual(Object.keys(shipped.models.development), [...DEVELOPMENT_ROLES]);
  assert.equal(
    roleModel({}, 'memory'),
    roleModel({}, 'core'),
    "with no chain: the built-in default of the memory role is the core's default"
  );
  const agents = Object.fromEntries(Object.entries(ROLE_DEFAULTS).filter(([role]) => OPENCODE_ROLES.includes(role)));
  assert.deepEqual({ ...shipped.models.errands, ...shipped.models.development }, agents);
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
  // Changed: an optional role with no chain is off (slice 4), so only the other roles resolve to their default.
  const optional = ['vision', 'video', 'speech', 'drawing'];
  for (const role of ROLES)
    assert.equal(roleModel({}, role), optional.includes(role) ? undefined : ROLE_DEFAULTS[role], role);
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
  const config = loadWith({ models: { routes: on('vision', 'x/v') } });
  assert.equal(roleModel(config, 'vision'), 'x/v');
  assert.equal(roleModel(config, 'core'), ROLE_DEFAULTS.core);
  assert.equal(roleModel(loadWith(undefined), 'vision'), undefined, 'the tracked vision has no chain, so off');
});

// ---- every purpose resolves --------------------------------------------------

test("purposes: under config.json every purpose resolves to its role's default model", () => {
  const config = loadWith(undefined);
  for (const [purpose, role] of Object.entries(PURPOSE_ROLES)) {
    // The tracked optional roles are off, so their purposes resolve to no model (tests/llm-roles.test.ts).
    const off = ['vision', 'video', 'speech', 'drawing'].includes(role);
    assert.equal(roleModel(config, role, purpose), off ? undefined : ROLE_DEFAULTS[role], purpose);
  }
});

// ---- the call sites ----------------------------------------------------------

/**
 * Every .js/.mjs file under src/ and scripts/, as [relative path, text], the TypeScript files of the folders that were
 * JavaScript when this check was written, and the modules at the root of `src/` (their call sites stay in the count
 * after the conversion).
 */
const CONVERTED_FOLDERS = [
  'src/agent-runner/',
  'src/behavior/',
  'src/interface/',
  'src/llm/',
  'src/media/',
  'src/memory/',
  'src/protocol/',
  'src/speech/',
  'src/web/',
  'scripts/',
];

function sources() {
  const out: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (
        /\.m?js$/.test(name) ||
        (name.endsWith('.ts') &&
          (/^src\/[^/]+\.ts$/.test(path.relative(ROOT, full)) ||
            CONVERTED_FOLDERS.some((folder) => path.relative(ROOT, full).startsWith(folder))))
      )
        out.push([path.relative(ROOT, full), fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'scripts'));
  return out;
}

test('call sites: every request role is one of the roles, every purpose goes out on its own role', () => {
  const chatRoles = new Set(['system', 'user', 'assistant', 'tool']);
  let pairs = 0;
  for (const [file, text] of sources()) {
    // A semantic predicate's argument also has a `role`; those files send no request.
    const semantic = /memory[\\/]db[\\/]semantic-/.test(file);
    for (const [, role] of semantic ? [] : text.matchAll(/\brole: '([\w.-]+)'/g)) {
      if (!chatRoles.has(role)) assert.ok(isRole(role), `${file}: role '${role}'`);
      assert.ok(
        !OPENCODE_ROLES.includes(role),
        `${file}: no request of the bot goes out on the OpenCode role '${role}'`
      );
    }
    for (const [, role, purpose] of text.matchAll(/roleModel\([\w.]+, '([\w-]+)', '([\w-]+)'\)/g)) {
      assert.equal(purposeRoles[purpose], role, `${file}: roleModel for ${purpose}`);
      pairs += 1;
    }
    for (const [, role, purpose] of text.matchAll(
      /roleRequestOptions\([\w.]+, \{\s*role: '([\w-]+)'[^}]*?purpose: '([\w-]+)'/g
    )) {
      assert.equal(purposeRoles[purpose], role, `${file}: helper request for ${purpose}`);
      pairs += 1;
    }
  }
  // Changed: quick search's two requests name SEARCH_ROLE, which this pattern does not read, so two sites count less.
  assert.ok(pairs >= 28, `found ${pairs} role/purpose pairs`);
});

test('a role with a chain in models.routes takes the model of its first route, and models.base is not read', () => {
  // Catches: a request built with the retired `models.base` model while the chain the owner set names another, or a
  // role the migration missed still running on the retired setting.
  const config = {
    models: {
      base: { analyzer: 'openai/gpt-6.1-sol', vision: 'google/gemini-4-argon', video: 'google/gemini-4-argon' },
      routes: { analyzer: [{ via: 'api', key: 'helpers', model: 'anthropic/claude-sonnet-6.1' }], vision: [] },
    },
  };
  assert.equal(roleModel(config, 'analyzer'), 'anthropic/claude-sonnet-6.1');
  assert.equal(roleModel(config, 'vision'), undefined, 'an empty chain turns an optional role off');
  assert.equal(roleOn(config, 'vision'), false);
  assert.equal(roleModel(config, 'video'), undefined, 'models.base.video is not read');
});

test('quick search takes the model of the first route of its chain, and web.quickSearch.model is not read', () => {
  // Catches: quick search answering with the retired setting's model after its chain was set, or with no chain.
  const config = {
    models: { routes: { search: [{ via: 'api', key: 'helpers', model: 'perplexity/sonar-pro' }] } },
    web: { quickSearch: { model: 'perplexity/sonar' } },
  };
  assert.equal(searchModel(config), 'perplexity/sonar-pro');
  assert.equal(searchModel({ web: { quickSearch: { model: 'perplexity/sonar' } } }), undefined);
});

// Tests for the on and off state of the optional model roles (src/llm/roles.ts#roleOn and #offRoles, the
// `no-model` answer of src/llm/role-health.ts and config/config.json). `vision`, `video`, `drawing` and `speech` are on
// while their chain in `models.routes` holds a route and off with none, the tracked default; `core`, `memory`,
// `analyzer` and `embedding` are mandatory. The other tests of the roles are in tests/roles.test.ts.
// Changed: `models.base` is retired (spec 2026-11-09-model-routes, slice 4), so a role is on by its chain; the tests of
// an absent `models.base` key and of the schema's `models.base` types are deleted with the setting.

/** The tracked config.json with `local` merged over it, as the core reads a deployment. */
function llmRolesLoadWith(local: unknown) {
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

// Bug caught: `/model set` writing a chain that the tracked settings still keep off.
test('a local chain over the tracked config turns that role on and leaves the others off', () => {
  const config = llmRolesLoadWith(withChains({ drawing: 'openai/gpt-image-x' }));
  assert.equal(roleOn(config, 'drawing'), true);
  assert.equal(roleModel(config, 'drawing'), 'openai/gpt-image-x');
  assert.deepEqual(offRoles(config), ['vision', 'video', 'speech']);
});
