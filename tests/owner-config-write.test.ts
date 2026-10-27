// The owner commands read and write the raw local file (`config.local.json`), and the engine moves the keys of an old name
// when it loads that file (src/config-moves.ts). A command that read the raw file would add a key under the new name
// beside the old one, and the next load would let the new one win. So the commands that edit the file (`set`,
// `access grant`, `access revoke`) read it with the moves applied and write it back settled: no key of an old name is left,
// the grants the file held under the old names are the ones the command changes, and a reload gives what the owner meant.
// Real config loader over a temporary checkout and private folder; the persona's id is `self-1`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAdmin } from '../src/admin.js';
import { readConfig } from '../src/config.js';
import { grantedToPersona } from '../src/tools/access.ts';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

type Settings = Record<string, unknown>;
const SELF = 'self-1';
const grant = { everyone: false, roles: [], users: [SELF] };

/** An admin over a checkout with a tracked config.json and a private folder whose config.local.json is `local`. */
function deployment(local: Settings) {
  const root = tempDir('nep-owner-write-');
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({
      features: { tools: true, toolsDiscovery: true, intentions: true },
      tools: { safeMode: false },
      bot: { owners: ['42'], access: {} },
      errands: { maxOpen: 3 },
    })
  );
  const file = path.join(root, 'config.local.json');
  fs.writeFileSync(file, JSON.stringify(local));
  const load = () => readConfig(root, { privateDir: root }) as Settings;
  const hot: Settings & { config: Settings; reloadConfig: () => boolean } = {
    rootDir: root,
    privateDir: root,
    config: load(),
    reloadConfig: () => {
      hot.config = load();
      return true;
    },
  };
  const admin = createAdmin({ hot, store: {}, selfId: () => SELF, getGuildId: () => 'g1' });
  const written = () => JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;
  return { admin, hot, written };
}

const accessOf = (config: Settings): Settings => (config.bot as Settings).access as Settings;
const run = <T>(fn: () => Promise<T>) => withCapturedLogs(fn);

test('settles the grants of an old name in the file when a command writes another grant, and her grants survive the reload', async () => {
  const world = deployment({ bot: { access: { 'task.run': grant, 'task.status': grant } } });
  await run(() => world.admin.run('access.grant', { command: 'status.show', userId: 'u9' }, {}));
  const access = accessOf(world.written());
  assert.deepEqual(Object.keys(access).sort(), ['errand.run', 'errand.status', 'status.show']);
  assert.deepEqual(access['errand.run'], grant);
  assert.equal(grantedToPersona(world.hot.config, SELF, 'errand.run'), true);
  assert.equal(grantedToPersona(world.hot.config, SELF, 'errand.status'), true);
});

test('grants errand.run to her over a file that holds the grant as task.run, and no old key is left behind', async () => {
  const world = deployment({ bot: { access: { 'task.run': grant, 'task.read': grant } } });
  await run(() => world.admin.run('access.grant', { command: 'errand.run', userId: SELF }, {}));
  const access = accessOf(world.written());
  assert.deepEqual(Object.keys(access).sort(), ['errand.read', 'errand.run']);
  assert.equal(grantedToPersona(world.hot.config, SELF, 'errand.read'), true);
});

test('revokes errand.run from her when the file holds her grant as task.run', async () => {
  const world = deployment({ bot: { access: { 'task.run': grant, 'task.read': grant } } });
  const reply = await run(() => world.admin.run('access.revoke', { command: 'errand.run', userId: SELF }, {}));
  assert.equal(String(reply.result).startsWith('Revoked errand.run'), true);
  assert.equal(grantedToPersona(world.hot.config, SELF, 'errand.run'), false);
  assert.equal(grantedToPersona(world.hot.config, SELF, 'errand.read'), true, 'the other grant stays');
});

test('sets errands.maxOpen over a file that still holds agents.maxOpen, and the file keeps only the new key', async () => {
  const world = deployment({ agents: { maxOpen: 7 } });
  await run(() => world.admin.run('set', { path: 'errands.maxOpen', value: '5' }, {}));
  assert.deepEqual(world.written(), { errands: { maxOpen: 5 } });
  assert.equal((world.hot.config.errands as Settings).maxOpen, 5);
});

test('writes nothing different to a file that holds no old key', async () => {
  const world = deployment({ bot: { access: { 'message.edit': grant } } });
  await run(() => world.admin.run('access.grant', { command: 'status.show', userId: 'u9' }, {}));
  assert.deepEqual(Object.keys(accessOf(world.written())).sort(), ['message.edit', 'status.show']);
});
