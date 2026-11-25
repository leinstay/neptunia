import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ROLE_DEFAULTS } from '../../../../src/llm/roles.ts';
import { makeAdmin, makeHotWithMedia, makeRoot, readLocal } from '../../../fixtures/admin-rig.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import { localPath } from '../../../fixtures/config-local.ts';

// ---------------------------------------------------------------------------
// model.show / model.set
// ---------------------------------------------------------------------------

test("run: model.show lists each role with its own model; an unset role shows its own default, never another role's", async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  hot.config.models = {
    ...hot.config.models,
    agents: { via: { scout: 'opencode' }, model: { scout: 'vendor/agent' } },
  };
  const { admin } = makeAdmin(rootDir, { hot });

  const lines = (await admin.run('model.show', {}, {})).split('\n');
  assert.ok(lines.includes('vision: anthropic/claude-haiku-4.5'));
  assert.ok(lines.includes(`analyzer: ${ROLE_DEFAULTS.analyzer}`), 'the analyzer is not the vision model');
  assert.ok(!lines.some((line: string) => line.startsWith('reasoner')), 'the reasoner is merged into the analyzer');
  // Changed: the development roles `thinker` and `dev` are gone (maintainer, 2026-11-16).
  assert.deepEqual(
    lines.map((line: string) => line.split(':')[0]),
    // Changed: the agents are read from disk: `code`, `scout` and `server`.
    [
      'base',
      'core',
      'analyzer',
      'vision',
      'video',
      'embedding',
      'speech',
      'drawing',
      'errands',
      'code',
      'scout',
      'server',
    ],
    'the base roles, then the errand roles under their group line'
  );
  assert.equal(lines[0], 'base:');
  assert.equal(lines[8], 'errands:');
  // Changed: an agent's line is its route, harness and model, `-` with no route, and `code` comes
  // first.
  assert.deepEqual(lines.slice(10, 12), ['scout: opencode-harness vendor/agent', 'server: -']);
});

/** `hot` with a chain of one route on `main` for each role of `models`, over the chains it holds. */
function withChains(hot: ReturnType<typeof makeHotWithMedia>, models: Record<string, string>) {
  hot.config.models = { ...hot.config.models, routes: { ...hot.config.models.routes, ...chainsOf(models) } };
  return hot;
}

// Changed: an agent's model is its route's, which `/model set <agent>` writes through the subharness, so model.set
// takes the base roles alone.
test("run: model.set puts the model on each route of a base role's chain", async () => {
  // Changed: a base role's model is its chain's (spec 2026-11-09-model-routes, slice 4), so the rig gives each base role
  // a chain on `main` first, and the set rewrites the model of that chain.
  const rootDir = makeRoot();
  const hot = withChains(makeHotWithMedia(rootDir), {
    analyzer: 'x/analyzer',
    video: 'x/video',
    embedding: 'x/embedding',
    drawing: 'x/drawing',
  });
  const changedAt = Date.UTC(2026, 9, 15, 9, 30);
  const { admin } = makeAdmin(rootDir, { hot, now: () => changedAt });

  await admin.run('model.set', { role: 'core', id: 'anthropic/claude-opus-4.6' }, {});
  assert.deepEqual(readLocal(rootDir), { models: { routes: chainsOf({ core: 'anthropic/claude-opus-4.6' }) } });

  await admin.run('model.set', { role: 'analyzer', id: 'openrouter/text-model' }, {});
  await admin.run('model.set', { role: 'vision', id: 'anthropic/claude-haiku-4.5' }, {});
  await admin.run('model.set', { role: 'video', id: 'openrouter/video-model' }, {});
  await admin.run('model.set', { role: 'embedding', id: 'openai/text-embedding-3-small' }, {});
  await admin.run('model.set', { role: 'drawing', id: 'openai/gpt-image-x' }, {});
  assert.deepEqual(readLocal(rootDir), {
    models: {
      routes: chainsOf({
        core: 'anthropic/claude-opus-4.6',
        analyzer: 'openrouter/text-model',
        vision: 'anthropic/claude-haiku-4.5',
        video: 'openrouter/video-model',
        embedding: 'openai/text-embedding-3-small',
        drawing: 'openai/gpt-image-x',
      }),
    },
    // The video model changed (the vision one was set to the model it already had).
    media: { recacheBefore: new Date(changedAt).toISOString() },
  });
  // Changed: the development roles `thinker` and `dev` are gone (maintainer, 2026-11-16).
  assert.equal(hot.reloadConfigCalls, 6);
});

test('run: model.set vision or video sets media.recacheBefore to the moment of the change and says so; other roles never do', async () => {
  const changedAt = Date.UTC(2026, 9, 15, 9, 30);
  const iso = new Date(changedAt).toISOString();
  const everyChain = { analyzer: 'x/a', video: 'x/v', embedding: 'x/e', drawing: 'x/d' };
  for (const role of ['vision', 'video']) {
    const rootDir = makeRoot();
    const hot = withChains(makeHotWithMedia(rootDir), everyChain);
    const { admin } = makeAdmin(rootDir, { hot, now: () => changedAt });
    const reply = await admin.run('model.set', { role, id: 'google/a-new-model' }, {});
    assert.deepEqual(
      readLocal(rootDir),
      { models: { routes: chainsOf({ [role]: 'google/a-new-model' }) }, media: { recacheBefore: iso } },
      role
    );
    assert.equal(hot.reloadConfigCalls, 1, `${role}: one write, one reload`);
    assert.match(reply, /^Set (vision|video) model to google\/a-new-model \(reload ok\)\n/);
    assert.ok(reply.includes(`media.recacheBefore set to ${iso}`), role);
  }
  // Changed: the development roles `thinker` and `dev` are gone (maintainer, 2026-11-16).
  for (const role of ['core', 'analyzer', 'embedding', 'drawing']) {
    const rootDir = makeRoot();
    const hot = withChains(makeHotWithMedia(rootDir), everyChain);
    const { admin } = makeAdmin(rootDir, { hot, now: () => changedAt });
    const reply = await admin.run('model.set', { role, id: 'google/a-new-model' }, {});
    assert.equal(readLocal(rootDir).media, undefined, role);
    assert.ok(!reply.includes('recacheBefore'), role);
  }
});

test('run: model.set vision to the model it already has leaves media.recacheBefore alone', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });
  await admin.run('model.set', { role: 'vision', id: 'anthropic/claude-haiku-4.5' }, {});
  assert.deepEqual(readLocal(rootDir), { models: { routes: chainsOf({ vision: 'anthropic/claude-haiku-4.5' }) } });
});

test('run: model.set refuses a base role with no chain, whose key it cannot name, and writes nothing', async () => {
  // Catches: a model written for a role with no route, which no request reads, so the set looks done and changes nothing.
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });
  await assert.rejects(() => admin.run('model.set', { role: 'speech', id: 'x/voice' }, {}), /no route/);
  assert.equal(fs.existsSync(localPath(rootDir)), false);
});

test('run: model.set rejects an unknown role and a role name that is no longer one, and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  // Changed: the development roles `thinker` and `dev` are gone (maintainer, 2026-11-16), and the agents `scout` and
  // `server` run on their routes, which model.set never writes.
  for (const role of ['bogus', 'web', 'voice', 'writer', 'memory', 'byPurpose', 'thinker', 'dev', 'scout', 'server']) {
    await assert.rejects(
      () => admin.run('model.set', { role, id: 'x/y' }, {}),
      new RegExp(
        `unknown role: ${role.replace('.', '\\.')} \\(core, analyzer, vision, video, embedding, speech, drawing\\)`
      ),
      role
    );
  }
  assert.equal(fs.existsSync(localPath(rootDir)), false);
});

test('run: model.set rejects an id that does not look like a model id', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  await assert.rejects(() => admin.run('model.set', { role: 'core', id: 'x' }, {}), /model id/);
  await assert.rejects(() => admin.run('model.set', { role: 'drawing', id: 'has spaces here' }, {}), /model id/);
  assert.equal(fs.existsSync(localPath(rootDir)), false);
});

test('run: model.set accepts a loosely-valid id (letters, digits, dot, colon, slash, dash, underscore)', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir), now: () => 0 });

  await admin.run('model.set', { role: 'vision', id: 'anthropic/claude-haiku-4.5:beta' }, {});
  assert.deepEqual(readLocal(rootDir), {
    models: { routes: chainsOf({ vision: 'anthropic/claude-haiku-4.5:beta' }) },
    media: { recacheBefore: new Date(0).toISOString() },
  });
});

test('model set drawing: writes the drawing chain to config.local.json, reloads, and model show lists it', async () => {
  // Changed: the drawing model is its chain's (slice 4), so the rig starts drawing on a chain of its own.
  const rootDir = makeRoot();
  const hot = withChains(makeHotWithMedia(rootDir), { drawing: ROLE_DEFAULTS.drawing });
  hot.reloadConfig = function reloadConfig() {
    this.reloadConfigCalls += 1;
    const itsModels = this.config.models;
    this.config.models = {
      ...this.config.models,
      routes: { ...itsModels?.routes, ...readLocal(rootDir).models.routes },
    };
    return true;
  };
  const { admin } = makeAdmin(rootDir, { hot });

  assert.ok((await admin.run('model.show', {}, {})).split('\n').includes(`drawing: ${ROLE_DEFAULTS.drawing}`));
  const reply = await admin.run('model.set', { role: 'drawing', id: 'openai/gpt-image-x' }, {});
  assert.match(reply, /^Set drawing model to openai\/gpt-image-x /);
  assert.deepEqual(readLocal(rootDir), { models: { routes: chainsOf({ drawing: 'openai/gpt-image-x' }) } });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.ok((await admin.run('model.show', {}, {})).split('\n').includes('drawing: openai/gpt-image-x'));
});
