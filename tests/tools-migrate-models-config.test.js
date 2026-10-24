// Tests for tools/migrate-models-config.mjs: the one-off move of a config file from the flat
// `roles` map, or the `models.base` section, to `models.core` / `models.helpers` / `models.byPurpose` /
// `models.agents` (src/config.js#migrateModelsKeys): a dry run by
// default, `--write` rewrites the file (mode kept), a file it cannot migrate is refused, nothing
// written; the migrated file loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../tools/migrate-models-config.mjs';
import { CliError } from '../tools/lib/cli.mjs';
import { loadConfig } from '../src/config.js';
import { roleModel } from '../src/llm/roles.js';
import { tempDir } from './fixtures/tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A local layer as the live file was before the move: the flat roles map, the dotted agent roles, agent.advice. */
const OLD_LOCAL = {
  bot: { owners: ['1'] },
  roles: {
    voice: 'vendor/voice-model',
    analyzer: 'vendor/analyzer-model',
    byPurpose: { lookup: 'vendor/lookup-model' },
    drawing: 'vendor/image-model',
    'agent.web': 'openrouter/vendor/web-model',
    'agent.dev': 'openrouter/vendor/dev-model',
    'agent.advice': 'vendor/advice-model',
  },
  llm: { keyByRole: { 'agent.web': 'OPENROUTER_ERRAND_KEY', 'agent.server': 'OPENROUTER_ERRAND_KEY', 'agent.advice': 'OPENROUTER_SIM_KEY' } },
};

/** A scratch dir holding `config.local.json` with `content` (mode 0600). */
function scratch(content) {
  const dir = tempDir('nep-migrate-');
  const file = path.join(dir, 'config.local.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { dir, file };
}

test('migrate-models-config: a dry run lists the moves, key names only, and writes nothing', async () => {
  const { dir, file } = scratch(OLD_LOCAL);
  const before = fs.readFileSync(file, 'utf8');
  const out = await main(['config.local.json'], { cwd: dir });
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing written');
  const lines = out.trimEnd().split('\n');
  assert.equal(lines[0], `${file}: dry run, nothing written (--write to apply)`);
  assert.deepEqual(lines.slice(1), [
    'roles.voice -> models.core',
    'roles.analyzer -> models.helpers.analyzer',
    'roles.byPurpose -> models.byPurpose',
    'roles.drawing -> models.agents.drawing',
    'roles.agent.web -> models.agents.web',
    'roles.agent.dev -> models.agents.dev',
    'drop roles.agent.advice',
    'llm.keyByRole.agent.web -> llm.keyByRole.web',
    'llm.keyByRole.agent.server -> llm.keyByRole.server',
    'drop llm.keyByRole.agent.advice',
  ]);
  assert.equal(out.includes('vendor/'), false, 'never a value');
});

test('migrate-models-config: --write moves the keys in place, keeps the file mode, and the result loads', async () => {
  const { dir, file } = scratch(OLD_LOCAL);
  const out = await main([file, '--write'], { cwd: '/' });
  assert.match(out, /: migrated\n/);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written, {
    bot: { owners: ['1'] },
    models: {
      core: 'vendor/voice-model', helpers: { analyzer: 'vendor/analyzer-model' }, byPurpose: { lookup: 'vendor/lookup-model' },
      agents: { drawing: 'vendor/image-model', web: 'openrouter/vendor/web-model', dev: 'openrouter/vendor/dev-model' },
    },
    llm: { keyByRole: { web: 'OPENROUTER_ERRAND_KEY', server: 'OPENROUTER_ERRAND_KEY' } },
  });
  assert.deepEqual(Object.keys(written), ['bot', 'models', 'llm'], 'models where roles stood');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the mode is kept');
  assert.deepEqual(fs.readdirSync(dir), ['config.local.json'], 'no temporary file left');

  fs.copyFileSync(path.join(ROOT, 'config.json'), path.join(dir, 'config.json'));
  const { config } = loadConfig(dir);
  assert.equal(roleModel(config, 'core'), 'vendor/voice-model');
  assert.equal(roleModel(config, 'analyzer', 'lookup'), 'vendor/lookup-model');
  assert.equal(roleModel(config, 'web'), 'openrouter/vendor/web-model');
  assert.equal(roleModel(config, 'drawing'), 'vendor/image-model');
  assert.equal(config.llm.keyByRole.dev, 'OPENROUTER_DEV_KEY', 'config.json fills the rest');

  assert.equal(await main([file, '--write'], { cwd: '/' }), `${file}: nothing to migrate\n`, 'a second run moves nothing');
});

test('migrate-models-config: an unknown roles key or a move onto a set key is refused, nothing written', async () => {
  const { dir, file } = scratch({ models: { core: 'new/v' }, roles: { voice: 'old/v', odd: 'x/o' } });
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(() => main(['config.local.json', '--write'], { cwd: dir }), (err) => {
    assert.ok(err instanceof CliError);
    assert.match(err.message, /not migrated, nothing written/);
    assert.match(err.message, /roles\.odd: no new key/);
    assert.match(err.message, /roles\.voice -> models\.core: the new key is already set/);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

/** A local layer as the live file was between the two moves: `models.base` with the role `voice`, read today as aliases. */
const BASE_LOCAL = {
  models: { base: { voice: 'vendor/voice-model', extractor: 'vendor/extractor-model', byPurpose: { reply: 'vendor/reply-model' } }, agents: { web: 'openrouter/vendor/web-model' } },
  llm: {
    keyByRole: { voice: 'OPENROUTER_VOICE_KEY', web: 'OPENROUTER_ERRAND_KEY' },
    cache: { roles: ['voice'] },
    hedge: { roles: ['analyzer'] },
    providerByModel: { 'anthropic/@voice': { order: ['anthropic'] }, 'openai/': { order: ['openai'] } },
  },
};

test('migrate-models-config: models.base and the role voice move to models.core / models.helpers / models.byPurpose and core, in the dry run and on --write', async () => {
  const { dir, file } = scratch(BASE_LOCAL);
  const before = fs.readFileSync(file, 'utf8');
  const dry = await main(['config.local.json'], { cwd: dir });
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing written');
  assert.deepEqual(dry.trimEnd().split('\n').slice(1), [
    'models.base.voice -> models.core',
    'models.base.extractor -> models.helpers.extractor',
    'models.base.byPurpose -> models.byPurpose',
    'llm.keyByRole.voice -> llm.keyByRole.core',
    'llm.cache.roles: voice -> llm.cache.roles: core',
    'llm.providerByModel: anthropic/@voice -> llm.providerByModel: anthropic/@core',
  ]);
  assert.equal(dry.includes('vendor/'), false, 'never a value');

  await main([file, '--write'], { cwd: '/' });
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written, {
    models: { core: 'vendor/voice-model', helpers: { extractor: 'vendor/extractor-model' }, byPurpose: { reply: 'vendor/reply-model' }, agents: { web: 'openrouter/vendor/web-model' } },
    llm: {
      keyByRole: { core: 'OPENROUTER_VOICE_KEY', web: 'OPENROUTER_ERRAND_KEY' },
      cache: { roles: ['core'] },
      hedge: { roles: ['analyzer'] },
      providerByModel: { 'openai/': { order: ['openai'] }, 'anthropic/@core': { order: ['anthropic'] } },
    },
  });
  fs.copyFileSync(path.join(ROOT, 'config.json'), path.join(dir, 'config.json'));
  const { config, renamed } = loadConfig(dir);
  assert.deepEqual(renamed, [], 'the written file carries no alias');
  assert.equal(roleModel(config, 'core', 'reply'), 'vendor/reply-model');
  assert.equal(roleModel(config, 'extractor'), 'vendor/extractor-model');
  assert.equal(await main([file, '--write'], { cwd: '/' }), `${file}: nothing to migrate\n`, 'a second run moves nothing');
});

test('migrate-models-config: the shipped config.json has nothing to migrate', async () => {
  assert.equal(await main([path.join(ROOT, 'config.json')]), `${path.join(ROOT, 'config.json')}: nothing to migrate\n`);
});

test('migrate-models-config: usage, unreadable and invalid files are CliErrors', async () => {
  await assert.rejects(() => main([]), CliError);
  await assert.rejects(() => main(['a.json', 'b.json']), CliError);
  await assert.rejects(() => main(['a.json', '--force']), CliError);
  const { dir } = scratch('{ not json');
  await assert.rejects(() => main(['config.local.json'], { cwd: dir }), /is not valid JSON/);
  await assert.rejects(() => main(['missing.json'], { cwd: dir }), /cannot read .*missing\.json \(ENOENT\)/);
  const array = scratch('[]');
  await assert.rejects(() => main(['config.local.json'], { cwd: array.dir }), /is not a JSON object/);
});
