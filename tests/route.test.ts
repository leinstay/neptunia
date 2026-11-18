import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { localPath, madeLocalPath } from './fixtures/config-local.ts';
import { makeAdmin, makeHotWithMedia, makeRoot, readLocal } from './fixtures/admin-rig.ts';
import { MEMORY_ROLE_DEFAULT, ROLE_DEFAULTS } from '../src/llm/roles.ts';
import { chainsOnDefaults } from './fixtures/chains.ts';
import { ROUTE_ROLES } from '../src/llm/route-text.ts';

// The operations of src/tools/operations/route.ts: route.list, route.set and route.remove over llm.providerByModel.

type Admin = ReturnType<typeof makeAdmin>['admin'];

/** What an operation answers, as text. */
const runText = async (admin: Admin, op: string, args: Record<string, unknown>): Promise<string> =>
  String(await admin.run(op, args, {}));

/** `llm.providerByModel` of the private settings file. */
const routesOf = (rootDir: string): unknown =>
  (readLocal(rootDir) as { llm: { providerByModel: unknown } }).llm.providerByModel;

test('run: route.set without a role writes { only, allow_fallbacks: false } under the bare prefix and reloads', async () => {
  const rootDir = makeRoot();
  fs.writeFileSync(madeLocalPath(rootDir), JSON.stringify({ llm: { model: 'x/kept' } }));
  const { admin, hot } = makeAdmin(rootDir);

  const result = await runText(admin, 'route.set', { model: 'google/', providers: 'google-vertex' });

  assert.deepEqual(readLocal(rootDir), {
    llm: { model: 'x/kept', providerByModel: { 'google/': { only: ['google-vertex'], allow_fallbacks: false } } },
  });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.match(result, /google\//);
});

test('run: route.set with a role writes "<prefix>@<role>"; a dotted model id stays one key; fallbacks true is kept', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('route.set', { model: 'google/', providers: 'google-vertex' }, {});
  await admin.run(
    'route.set',
    { model: 'google/', providers: ' google-ai-studio , google-vertex ,', role: 'video' },
    {}
  );
  await admin.run(
    'route.set',
    { model: 'anthropic/claude-sonnet-4.6', providers: 'amazon-bedrock', role: 'core', fallbacks: true },
    {}
  );

  assert.deepEqual(routesOf(rootDir), {
    'google/': { only: ['google-vertex'], allow_fallbacks: false },
    'google/@video': { only: ['google-ai-studio', 'google-vertex'], allow_fallbacks: false },
    'anthropic/claude-sonnet-4.6@core': { only: ['amazon-bedrock'], allow_fallbacks: true },
  });
});

test('run: route.set validates the prefix, the providers and the role, writing nothing on an error', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  const bad = [
    [{ model: '', providers: 'google-vertex' }, /model/],
    [{ model: '   ', providers: 'google-vertex' }, /model/],
    [{ model: 'google/@core', providers: 'google-vertex' }, /@/],
    [{ model: 'google /x', providers: 'google-vertex' }, /space/],
    [{ model: '__proto__', providers: 'google-vertex' }, /model/],
    [{ model: 'google/', providers: '' }, /provider/],
    [{ model: 'google/', providers: ' , ' }, /provider/],
    [{ model: 'google/', providers: 'Google-Vertex' }, /provider/],
    [{ model: 'google/', providers: 'google_vertex' }, /provider/],
    [{ model: 'google/', providers: 'google-vertex', role: 'bogus' }, /unknown role: bogus/],
    [{ model: 'google/', providers: 'google-vertex', role: 'web' }, /unknown role: web/],
    // An agent role's OpenCode worker never reads llm.providerByModel: no route may name it.
    [{ model: 'openrouter/', providers: 'openai', role: 'scout' }, /unknown role: scout/],
    [{ model: 'perplexity/', providers: 'perplexity', role: 'search' }, /unknown role: search/],
    [{ model: 'openrouter/', providers: 'openai', role: 'dev' }, /unknown role: dev/],
    [{ model: 'openrouter/', providers: 'openai', role: 'thinker' }, /unknown role: thinker/],
    [{ model: 'google/', providers: 'google-vertex', byok: 'yes' }, /byok must be true or false/],
    [{ model: 'google/', providers: 'google-vertex', byok: 'TRUE' }, /byok must be true or false/],
    [{ model: 'google/', providers: 'google-vertex', byok: 1 }, /byok must be true or false/],
  ];
  for (const [args, message] of bad) {
    await assert.rejects(() => admin.run('route.set', args, {}), message, JSON.stringify(args));
  }
  assert.equal(fs.existsSync(localPath(rootDir)), false);
  assert.equal(hot.reloadConfigCalls, 0);
});

test('run: route.set byok true writes byok: true and says byok: on; false or absent writes no key and says byok: off', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  const on = await runText(admin, 'route.set', { model: 'anthropic/', providers: 'amazon-bedrock', byok: 'true' });
  const off = await runText(admin, 'route.set', { model: 'google/', providers: 'google-vertex', byok: 'false' });
  const absent = await runText(admin, 'route.set', { model: 'openai/', providers: 'openai' });
  // A persona's call carries the flag as a boolean.
  await admin.run('route.set', { model: 'x-ai/', providers: 'xai', byok: true }, {});

  assert.deepEqual(routesOf(rootDir), {
    'anthropic/': { only: ['amazon-bedrock'], allow_fallbacks: false, byok: true },
    'google/': { only: ['google-vertex'], allow_fallbacks: false },
    'openai/': { only: ['openai'], allow_fallbacks: false },
    'x-ai/': { only: ['xai'], allow_fallbacks: false, byok: true },
  });
  assert.match(on, /fallbacks: off, byok: on /);
  assert.match(off, /fallbacks: off, byok: off /);
  assert.match(absent, /fallbacks: off, byok: off /);
});

test('run: route.remove deletes only the named key; an unknown route is an error and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  await admin.run('route.set', { model: 'google/', providers: 'google-vertex' }, {});
  await admin.run('route.set', { model: 'google/', providers: 'google-ai-studio', role: 'video' }, {});

  const result = await runText(admin, 'route.remove', { model: 'google/', role: 'video' });
  assert.match(result, /google\/@video/);
  assert.deepEqual(routesOf(rootDir), {
    'google/': { only: ['google-vertex'], allow_fallbacks: false },
  });
  assert.equal(hot.reloadConfigCalls, 3);

  const before = fs.readFileSync(localPath(rootDir), 'utf8');
  await assert.rejects(
    () => admin.run('route.remove', { model: 'google/', role: 'core' }, {}),
    /no route google\/@core/
  );
  await assert.rejects(() => admin.run('route.remove', { model: 'google/', role: 'bogus' }, {}), /unknown role/);
  assert.equal(fs.readFileSync(localPath(rootDir), 'utf8'), before);
  assert.equal(hot.reloadConfigCalls, 3);

  await admin.run('route.remove', { model: 'google/' }, {});
  assert.deepEqual(readLocal(rootDir), {}, 'the emptied map and llm object are pruned');
});

function hotForRoutes(rootDir: string) {
  const hot = makeHotWithMedia(rootDir);
  hot.config.llm = { ...(hot.config.llm as object), provider: null };
  hot.config.models = {
    routes: chainsOnDefaults({
      core: 'anthropic/claude-opus-4.6',
      analyzer: 'google/gemini-3.8-flash',
      vision: 'google/gemini-3.8-flash',
      video: 'google/gemini-3.8-flash',
      embedding: 'openai/text-embedding-x',
      drawing: 'openai/gpt-image-x',
      editor: 'perplexity/sonar-x',
      'linter': 'google/gemini-3.8-flash',
    }),
  };
  hot.config.image = { provider: { only: ['openai'] } };
  hot.config.media = { video: { provider: { order: ['google-ai-studio'], allow_fallbacks: false } } };
  return hot;
}

test('run: route.list renders every route (prefix, role or any, providers, fallbacks, byok) and the route each role gets', async () => {
  const rootDir = makeRoot();
  const hot = hotForRoutes(rootDir);
  hot.config.llm = { ...(hot.config.llm as object), provider: { ignore: ['some-provider'] } };
  const { admin } = makeAdmin(rootDir, { hot });
  await admin.run('route.set', { model: 'google/', providers: 'google-vertex' }, {});
  await admin.run('route.set', { model: 'google/', providers: 'google-ai-studio', role: 'video' }, {});
  await admin.run(
    'route.set',
    { model: 'anthropic/', providers: 'amazon-bedrock,anthropic', role: 'core', fallbacks: true, byok: 'true' },
    {}
  );

  const lines = (await runText(admin, 'route.list', {})).split('\n');

  assert.deepEqual(lines, [
    'routes:',
    '  anthropic/ | core | only amazon-bedrock, anthropic | fallbacks: on | byok: on',
    '  google/ | any | only google-vertex | fallbacks: off | byok: off',
    '  google/ | video | only google-ai-studio | fallbacks: off | byok: off',
    'by role:',
    '  core: anthropic/claude-opus-4.6 -> anthropic/@core (only amazon-bedrock, anthropic, fallbacks: on, byok)',
    `  memory: ${MEMORY_ROLE_DEFAULT} -> llm.provider (ignore some-provider, fallbacks: on)`,
    '  analyzer: google/gemini-3.8-flash -> google/ (only google-vertex, fallbacks: off)',
    '  vision: google/gemini-3.8-flash -> google/ (only google-vertex, fallbacks: off)',
    '  video: google/gemini-3.8-flash -> google/@video (only google-ai-studio, fallbacks: off); direct-URL videos: media.video.provider (order google-ai-studio, fallbacks: off)',
    '  embedding: openai/text-embedding-x -> llm.provider (ignore some-provider, fallbacks: on)',
    `  speech: ${ROLE_DEFAULTS.speech} -> llm.provider (ignore some-provider, fallbacks: on)`,
    '  drawing: openai/gpt-image-x -> image.provider (only openai, fallbacks: on)',
    '  linter: google/gemini-3.8-flash -> google/ (only google-vertex, fallbacks: off)',
    '  editor: perplexity/sonar-x -> llm.provider (ignore some-provider, fallbacks: on)',
    // Changed: the role `search` is gone from the routing, and the fixture gives its chain to `editor`.
    // Changed: the section lists every role the routing knows (src/llm/route-text.ts#ROUTE_ROLES), so memory and
    // the humanizer's roles get a line, each with its model read the way its requests read it.
    // Changed: the development roles `thinker` and `dev` are gone (maintainer, 2026-11-16), and the errand agents
    // with `models.errands` (owner, 2026-11-17): their routes are the subharness's, which route.list does not show.
  ]);
});

test('run: route.set takes the roles editor and linter, the by-role line obeys it, route.remove takes it back', async () => {
  // Catches: a role the routing knows is refused as unknown by route.set, or its by-role line is missing.
  // Changed: the role `search` is gone from the routing, so the humanizer's two roles stand for the roles beyond the base.
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: hotForRoutes(rootDir) });

  await admin.run('route.set', { model: 'google/', providers: 'google-vertex', role: 'linter' }, {});
  await admin.run('route.set', { model: 'perplexity/', providers: 'perplexity', role: 'editor' }, {});

  assert.deepEqual(routesOf(rootDir), {
    'google/@linter': { only: ['google-vertex'], allow_fallbacks: false },
    'perplexity/@editor': { only: ['perplexity'], allow_fallbacks: false },
  });
  const lines = (await runText(admin, 'route.list', {})).split('\n');
  assert.ok(
    lines.includes('  linter: google/gemini-3.8-flash -> google/@linter (only google-vertex, fallbacks: off)'),
    lines.join('\n')
  );
  assert.ok(
    lines.includes('  editor: perplexity/sonar-x -> perplexity/@editor (only perplexity, fallbacks: off)'),
    lines.join('\n')
  );

  await admin.run('route.remove', { model: 'google/', role: 'linter' }, {});
  await admin.run('route.remove', { model: 'perplexity/', role: 'editor' }, {});
  assert.deepEqual(readLocal(rootDir), {});
});

test('run: route.set and route.remove take every role the routing knows, and route.list has a line for each', async () => {
  // Catches: the commands keep a list of their own, so a role added to the routing cannot be named or seen.
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: hotForRoutes(rootDir) });
  for (const role of ROUTE_ROLES) await admin.run('route.set', { model: 'x/', providers: 'p', role }, {});

  assert.deepEqual(
    Object.keys(routesOf(rootDir) as object),
    ROUTE_ROLES.map((role) => `x/@${role}`)
  );
  const lines = (await runText(admin, 'route.list', {})).split('\n');
  const byRole = lines.slice(lines.indexOf('by role:') + 1).map((line) => line.trim().split(':')[0]);
  assert.deepEqual(byRole, [...ROUTE_ROLES]);

  for (const role of ROUTE_ROLES) await admin.run('route.remove', { model: 'x/', role }, {});
  assert.deepEqual(readLocal(rootDir), {});
});
