// Tests for src/tools/operations/access.ts: how the owner opens a skill to the persona with `access.grant` and
// `access.revoke`, by tool name or by a group, the operations no grant opens, and the rule that the persona never
// changes their own authority. The settings file is a temporary tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runOp } from '../../../../src/tools/operations/index.ts';
import { createOpsEnv } from '../../../../src/tools/operations/env.ts';
import { PERSONA_GOVERNED_CONFIG, governsPersona } from '../../../../src/tools/operations/rights.ts';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { skillRegistry } from '../../../../src/tools/registry.ts';
import { NOT_GRANTABLE_TO_PERSONA, skillAccess } from '../../../../src/tools/access.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { OWNER_PERSON, ownedBy } from '../../../fixtures/owner-accounts.ts';
import { localPath, madeLocalPath } from '../../../fixtures/config-local.ts';
import { makeAdmin, makeRoot, readLocal } from '../../../fixtures/admin-rig.ts';

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

const OWNER = '42';

const SELF = 'self-1';

/** A config with the settings these tests read, each set here (never the shipped defaults). */
type Grant = { everyone?: boolean; roles?: Array<string>; users?: Array<string> };

function config({ tools = {}, access = {} }: { tools?: Record<string, unknown>; access?: Record<string, Grant> } = {}) {
  return {
    tools: { safeMode: false, ...tools },
    bot: { ownerPerson: OWNER_PERSON, access },
  };
}

// ---- the owner grants a skill to the persona: access.grant and access.revoke with the persona as the user ----

function makeEnv({ cfg = config(), roles = [] }: Record<string, Untyped> = {}) {
  const rootDir = tempDir('nep-skills-');
  const hot = {
    config: cfg,
    prompts: { labels: {}, tools: {} },
    promptSources: {},
    rootDir,
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  const store = {
    state: { data: {}, markDirty() {} },
    flush() {},
    getUser: () => null,
    getPlace: () => ({}),
  };
  // The interface says who the persona is and which groups they hold (`memberInfo`).
  const client = {};
  const reads = {
    memberInfo: ({ accountId }: Untyped) =>
      Promise.resolve({
        member: {
          id: accountId,
          name: null,
          bot: false,
          groupIds: roles,
          avatar: { hash: null, url: null, largeUrl: null },
        },
      }),
  };
  const env = createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    reads,
    selfId: () => SELF,
    isServedRoot: (id: unknown) => id === 'g1',
    now: () => Date.UTC(2026, 9, 14, 10, 0, 0),
  } as unknown as Parameters<typeof createOpsEnv>[0]);
  /** `bot.access` as written to the private settings file (canonical persona config/config.json). */
  const stored = (): Record<string, Untyped> => {
    const file = path.join(rootDir, 'data', 'config', 'config.json');
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).bot?.access ?? {}) : {};
  };
  return { env, hot, store, client, stored, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

// Only the owner types commands, so a grant names the persona alone and takes the tool name only.
test('persona grants: a grant opens a skill to the persona by name, owner-only ones included; revoke closes it', async () => {
  const t = makeEnv();
  const owner = { env: t.env, placeId: 'g1', asOwner: true };
  try {
    // The write granted by name is `errand.cancel`, a tool of the persona's.
    for (const name of ['memory.private.read', 'message.edit', 'errand.cancel']) {
      const result = await runOp('access.grant', { command: name }, owner);
      assert.equal(result.status, 'ok', `${name}: ${result.summary}`);
    }
    const access = t.stored();
    for (const name of ['memory.private.read', 'message.edit', 'errand.cancel'])
      assert.deepEqual(access[name], { users: [SELF] }, name);
    const privateRead = skillRegistry().get('memory.private.read');
    assert.deepEqual(
      skillAccess({ skill: privateRead, config: config({ access }), selfId: SELF } as unknown as Parameters<
        typeof skillAccess
      >[0]),
      { allowed: true, reason: 'allowed' }
    );
    const list = (await runOp('access.list', {}, owner)).summary.split('\n');
    for (const name of ['memory.private.read', 'message.edit', 'errand.cancel'])
      assert.ok(list.includes(`${name}: user id:${SELF}`), name);
    assert.equal((await runOp('access.revoke', { command: 'memory.private.read' }, owner)).status, 'ok');
    assert.equal(
      skillAccess({ skill: privateRead, config: config({ access: t.stored() }), selfId: SELF } as unknown as Parameters<
        typeof skillAccess
      >[0]).allowed,
      false
    );
    // An operation of the owner's console alone is no skill to grant, like a name nothing has.
    for (const name of ['message.pin', 'status.show', 'lore.add']) {
      const unknown = await runOp('access.grant', { command: name }, owner);
      assert.deepEqual([unknown.status, unknown.code], ['invalid', 'unknown-skill'], name);
    }
  } finally {
    t.cleanup();
  }
});

test('persona grants: an irreversible or administrative operation is refused for the persona with a clear message', async () => {
  const t = makeEnv();
  const owner = { env: t.env, placeId: 'g1', asOwner: true };
  try {
    for (const name of NOT_GRANTABLE_TO_PERSONA) {
      // The grant takes the tool name alone, and the persona's id is the target.
      const result = await runOp('access.grant', { command: name }, owner);
      assert.deepEqual([result.status, result.code], ['invalid', 'not-grantable'], name);
      assert.match(result.summary, /cannot be granted to the persona yet/, name);
    }
    assert.deepEqual(t.stored(), {});
  } finally {
    t.cleanup();
  }
});

test("persona grants: a group or * opens the persona's read skills under it, owner-only reads included, never a write", async () => {
  const t = makeEnv();
  const owner = { env: t.env, placeId: 'g1', asOwner: true };
  try {
    // The grant takes the tool name alone, and the entry holds the persona's id alone.
    assert.equal((await runOp('access.grant', { command: '*' }, owner)).status, 'ok');
    const access = t.stored();
    const reads = [...skillRegistry().values()]
      .filter((skill) => skill.kind === 'read' && !NOT_GRANTABLE_TO_PERSONA.includes(skill.name))
      .map((skill) => skill.name);
    assert.deepEqual(Object.keys(access).sort(), [...reads].sort());
    // `status.show` and `lore.add` are operations of the console and no skill of the persona's, so `*` leaves them out.
    for (const name of ['lore.list', 'memory.profile.read', 'memory.private.read', 'intention.list'])
      assert.ok(access[name], name);
    for (const name of ['message.edit', 'lore.add', 'status.show', 'memory.restore', 'draw.create'])
      assert.equal(access[name], undefined, name);
    assert.deepEqual(access['lore.list'], { users: [SELF], via: { [`user:${SELF}`]: '*' } });
    const t2 = makeEnv();
    try {
      await runOp('access.grant', { command: 'memory' }, { ...owner, env: t2.env });
      assert.ok(t2.stored()['memory.server.read']);
      assert.equal(t2.stored()['memory.restore'], undefined);
    } finally {
      t2.cleanup();
    }
  } finally {
    t.cleanup();
  }
});

// Every grant is the persona's, so any grant or revoke the persona makes would change their own authority, and no
// grant targets everyone or a role.
test('persona grants: the persona never changes their effective authority, neither a grant nor the governed config', async () => {
  const t = makeEnv();
  const asPersona = { env: t.env, placeId: 'g1', accountId: OWNER, roleIds: [], actor: 'persona' };
  try {
    for (const name of ['access.grant', 'access.revoke'] as const) {
      const result = await runOp(name, { command: 'lore.list' }, asPersona);
      assert.deepEqual([result.status, result.code], ['denied', 'self-grant'], name);
    }
    assert.deepEqual(t.stored(), {}, 'nothing was written');
    for (const key of ['bot.ownerPerson', 'bot.access', 'tools.safeMode', 'tools.callTimeoutMs', 'bot'])
      assert.ok(governsPersona(key), key);
    for (const key of ['llm.maxRequestsPerDay', 'bot.timezone']) assert.equal(governsPersona(key), false, key);
    assert.ok(PERSONA_GOVERNED_CONFIG.includes('tools'));
    const set = await runOp('config.set', { path: 'tools.safeMode', value: 'false' }, asPersona);
    assert.deepEqual([set.status, set.code], ['denied', 'self-grant']);
    const unset = await runOp('config.unset', { path: 'tools.safeMode' }, asPersona);
    assert.deepEqual([unset.status, unset.code], ['denied', 'self-grant']);
  } finally {
    t.cleanup();
  }
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy([OWNER]);

// PR 7b: `admin.run` takes the operation's name (`status.show`, `config.set`, ...); every expectation is as it was.

// ---------------------------------------------------------------------------
// access.grant / access.revoke / access.list
// ---------------------------------------------------------------------------

// Only the privileged role types commands, and a grant names the persona alone.
// Changed: the tool is `memory.search`, since `status.show` is an operation of the console and no tool of the persona's.
test('run: access.grant stores the id of the persona alone under the operation name', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await admin.run('access.grant', { command: 'memory.search' }, {});
  assert.deepEqual(readLocal(rootDir), { bot: { access: { 'memory.search': { users: ['self-id'] } } } });
});

// Only the privileged role types commands, and a grant names the persona alone.
test('run: access.grant takes no role or other user: a stray target argument still grants the persona alone', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await admin.run('access.grant', { command: 'memory.search', roleId: '123' }, {});
  await admin.run('access.grant', { command: 'lore.list', accountId: '456' }, {});
  assert.deepEqual(readLocal(rootDir), {
    bot: { access: { 'memory.search': { users: ['self-id'] }, 'lore.list': { users: ['self-id'] } } },
  });
});

// Only the privileged role types commands, and a grant names the persona alone.
test('run: access.grant refuses and writes nothing while no interface has said who the persona is', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { selfId: () => null });
  await assert.rejects(() => admin.run('access.grant', { command: 'memory.search' }, {}));
  assert.equal(fs.existsSync(localPath(rootDir)), false);
});

test('run: access.grant rejects an unknown tool and an old command key, writing nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await assert.rejects(() => admin.run('access.grant', { command: 'nonsense' }, {}), /nonsense/);
  await assert.rejects(() => admin.run('access.grant', { command: 'memory.show' }, {}), /memory\.show/);
  assert.equal(fs.existsSync(localPath(rootDir)), false);
});

// Only the privileged role types commands, and a grant names the persona alone.
test('run: access.list names the grants of the persona alone; a key held by everyone, a role or another user is left out', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  const people = {
    'memory.search': { everyone: true, roles: [], users: [] },
    'lore.list': { everyone: false, roles: ['r1'], users: ['u-9'] },
  };
  fs.writeFileSync(
    madeLocalPath(rootDir),
    JSON.stringify({ bot: { access: { ...people, 'memory.private.read': { users: ['self-id'] } } } })
  );
  assert.equal(await admin.run('access.list', {}, {}), 'memory.private.read: user id:self-id');

  fs.writeFileSync(madeLocalPath(rootDir), JSON.stringify({ bot: { access: people } }));
  assert.equal(await admin.run('access.list', {}, {}), '(none)');
});

// Only the privileged role types commands, and a grant names the persona alone.
test('run: access.revoke of the last grant of the persona deletes the entry, even one that still holds everyone or a role', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  fs.writeFileSync(
    madeLocalPath(rootDir),
    JSON.stringify({ bot: { access: { 'memory.search': { everyone: true, roles: ['r1'], users: ['self-id'] } } } })
  );
  await admin.run('access.revoke', { command: 'memory.search' }, {});
  assert.deepEqual(readLocal(rootDir), { bot: { access: {} } });
});

// Only the privileged role types commands, and a grant names the persona alone.
test('run: access grant, list and revoke of a group: the reads of the persona under it, named with their source, revoked together', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('access.grant', { command: 'memory' }, {});
  const keys = Object.keys(readLocal(rootDir).bot.access);
  assert.ok(keys.length > 0 && keys.every((key) => key.startsWith('memory.')), keys.join(', '));
  const lines = (await admin.run('access.list', {}, {})).split('\n');
  assert.deepEqual(
    lines,
    keys.map((key) => `${key}: user id:self-id (expanded from memory, reads only)`)
  );

  await admin.run('access.revoke', { command: 'memory' }, {});
  assert.equal(await admin.run('access.list', {}, {}), '(none)');
  assert.equal(await admin.run('access.revoke', { command: 'memory' }, {}), 'Nothing to revoke');
});
