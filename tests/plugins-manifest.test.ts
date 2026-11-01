// plugin.json (src/plugins/manifest.ts): what the core accepts as the declaration of a plugin. Pure text in, a
// manifest or one code out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest } from '../src/plugins/manifest.ts';
import { echoManifest } from './fixtures/plugin-rig.ts';

const text = (change: (manifest: Record<string, unknown>) => void = () => {}): string => {
  const manifest = echoManifest() as unknown as Record<string, unknown>;
  const copy = structuredClone(manifest);
  change(copy);
  return JSON.stringify(copy);
};

test('reads the echo manifest whole when the folder name is its name', () => {
  const parsed = parseManifest(text(), 'echo');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.manifest, echoManifest());
});

test('refuses text that is not JSON, and JSON that is not an object', () => {
  assert.deepEqual(parseManifest('', 'echo'), { ok: false, code: 'not-json' });
  assert.deepEqual(parseManifest('{"name":', 'echo'), { ok: false, code: 'not-json' });
  assert.deepEqual(parseManifest('[]', 'echo'), { ok: false, code: 'not-object' });
});

test('refuses a manifest whose name is not its folder, and a name that is not kebab-case', () => {
  assert.deepEqual(parseManifest(text(), 'other'), { ok: false, code: 'name-mismatch' });
  assert.deepEqual(
    parseManifest(
      text((m) => (m.name = 'Echo Plugin')),
      'Echo Plugin'
    ),
    { ok: false, code: 'bad-name' }
  );
});

test('refuses a manifest with no description', () => {
  assert.deepEqual(
    parseManifest(
      text((m) => delete m.description),
      'echo'
    ),
    { ok: false, code: 'no-description' }
  );
});

test('refuses a tool outside the plugin prefix and a tool declared twice', () => {
  const wrong = text((m) => {
    (m.tools as Array<Record<string, unknown>>)[0].name = 'other.say';
  });
  assert.deepEqual(parseManifest(wrong, 'echo'), { ok: false, code: 'tool-prefix' });
  const twice = text((m) => {
    const tools = m.tools as Array<unknown>;
    tools.push(structuredClone(tools[0]));
  });
  assert.deepEqual(parseManifest(twice, 'echo'), { ok: false, code: 'tool-repeated' });
});

test('refuses a tool with a missing field or an unknown effect, and tools that are not a list', () => {
  const noRights = text((m) => delete (m.tools as Array<Record<string, unknown>>)[0].rights);
  assert.deepEqual(parseManifest(noRights, 'echo'), { ok: false, code: 'bad-tool' });
  const effect = text((m) => ((m.tools as Array<Record<string, unknown>>)[0].effect = 'explode'));
  assert.deepEqual(parseManifest(effect, 'echo'), { ok: false, code: 'bad-tool' });
  assert.deepEqual(
    parseManifest(
      text((m) => (m.tools = 'echo.say')),
      'echo'
    ),
    { ok: false, code: 'bad-tools' }
  );
});

test('takes a manifest with no tools, and defaults env and skills to empty lists', () => {
  const bare = JSON.stringify({ name: 'echo', description: 'Nothing yet.', tools: [] });
  const parsed = parseManifest(bare, 'echo');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.manifest.tools, []);
  assert.deepEqual(parsed.manifest.env, []);
  assert.deepEqual(parsed.manifest.skills, []);
});

test('refuses env keys that are not upper snake case and skill names that are not kebab-case', () => {
  assert.deepEqual(
    parseManifest(
      text((m) => (m.env = ['echo prefix'])),
      'echo'
    ),
    { ok: false, code: 'bad-env' }
  );
  assert.deepEqual(
    parseManifest(
      text((m) => (m.skills = ['Echo Say'])),
      'echo'
    ),
    { ok: false, code: 'bad-skills' }
  );
});
