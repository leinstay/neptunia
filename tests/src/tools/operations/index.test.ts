// Tests for src/tools/operations/index.ts: the typed operations behind the owner commands, the registry of their
// names and kinds, runOp with no caller check, and the result shape.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listOps, runOp } from '../../../../src/tools/operations/index.ts';
import { createOpsEnv } from '../../../../src/tools/operations/env.ts';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { OWNER_PERSON, ownedBy } from '../../../fixtures/owner-accounts.ts';
import type { TestMemory } from '../../../fixtures/memory-db/service.ts';

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

/** The agreed operation names, the wildcards spelled out. */
const AGREED = new Set([
  'skill.read',
  'skill.disable',
  'skill.run',
  'status.show',
  'config.set',
  'config.unset',
  'bot.pause',
  'bot.resume',
  'draw.create',
  'voice.say',
  'model.show',
  'model.set',
  'route.list',
  'route.set',
  'route.remove',
  'rule.add',
  'rule.list',
  'rule.remove',
  'access.grant',
  'access.revoke',
  'access.list',
  'lore.add',
  'lore.list',
  'lore.show',
  'lore.remove',
  'memory.profile.read',
  'memory.channel.read',
  'memory.server.read',
  'memory.recent.read',
  'memory.journal.read',
  'memory.archive.read',
  'memory.restore',
  'memory.private.read',
  'message.create',
  'message.edit',
  'message.delete',
  'message.react.add',
  'message.react.remove',
  'errand.server',
  'errand.scout',
  'errand.code',
  'errand.list',
  'errand.cancel',
  'errand.read',
  'errand.resolve',
  // The owner's view and switch of the agents on disk.
  'agent.list',
  'agent.enable',
  'agent.disable',
  'web.search',
  'web.read',
  'media.look',
  'media.find',
  'memory.search',
  'intention.set',
  'intention.update',
  'intention.cancel',
  'intention.list',
  'places.list',
  'tools.describe',
  'conversation.read',
  // memory.read, the persona's read of one subject, runs only inside a turn.
  'memory.read',
  'person.link',
]);

function makeEnv({
  access = {},
  journal,
}: {
  access?: object;
  journal?: { read: () => Promise<unknown> };
} = {}) {
  const rootDir = tempDir('nep-ops-');
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  const hot = {
    config: { bot: { ownerPerson: OWNER_PERSON, access }, llm: { model: 'x/y', maxRequestsPerDay: 10 } },
    prompts: { labels: {} },
    promptSources: {},
    promptsDir: path.join(rootDir, 'prompts'),
    localPromptsDir: path.join(rootDir, 'prompts.local'),
    rootDir,
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  const store = {
    state: { data: {}, markDirty() {} },
    flush() {},
    getUser: () => null,
    getPlace: () => ({ emojiUsage: {} }),
    // The owner's rules: none stored.
    liveRules: () => [],
  };
  return createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: {},
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedRoot: (id: unknown) => id === 'g1',
    ...(journal === undefined ? {} : { journal }),
  });
}

test('ops: every registered op has a rights kind and a name in the agreed list', () => {
  const ops = listOps();
  assert.ok(ops.length > 0);
  for (const op of ops) {
    assert.ok(AGREED.has(op.name), `${op.name} is not an agreed operation name`);
    assert.ok(op.rights.kind === 'read' || op.rights.kind === 'write', `${op.name} has no rights kind`);
  }
  const byName = new Map(ops.map((op) => [op.name, op]));
  // Every name of the lists below is registered, as the line above asserts.
  for (const name of AGREED) assert.ok(byName.has(name), `${name} is not registered`);
  // An operation declares its kind and nothing else, since no member rights layer exists.
  for (const op of ops) assert.deepEqual(Object.keys(op.rights), ['kind'], op.name);
  assert.equal(byName.get('memory.profile.read')!.rights.kind, 'read');
  // `memory.profile.read` and `errand.list` hold these reads, and no operation of the other names is registered.
  assert.equal(byName.has('memory.affinity.read'), false);
  assert.equal(byName.has('errand.status'), false);
  assert.equal(byName.has('memory.affinity.set'), false, 'the attitude changes through the analyzer alone');
});

// Only the owner types commands, so runOp checks no caller and no member grant.
test("ops: runOp runs an operation of the owner's console for any caller, with no grant stored", async () => {
  const env = makeEnv();
  const callers: Array<[string, Parameters<typeof runOp>[2]]> = [
    ['a member account', { env, placeId: 'g1', accountId: '999', roleIds: [] }],
    ['no account', { env, placeId: 'g1' }],
  ];
  for (const [label, ctx] of callers) {
    assert.equal((await runOp('access.list', {}, ctx)).status, 'ok', label);
    assert.equal((await runOp('rule.list', {}, ctx)).status, 'ok', label);
  }
});

test('ops: runOp returns invalid with a human summary for missing args', async () => {
  const env = makeEnv();
  const owner = { env, placeId: 'g1', accountId: '42' };
  const result = await runOp('rule.add', {}, owner);
  assert.equal(result.status, 'invalid');
  assert.equal(typeof result.code, 'string');
  assert.equal(result.summary, 'rule text is required');

  const affinity = await runOp('memory.affinity.set', { accountId: '7' }, owner);
  assert.equal(affinity.status, 'invalid', 'a set without a score never falls back to a read');

  const unknown = await runOp('no.such.op', {}, owner);
  assert.equal(unknown.status, 'invalid');
  assert.equal(unknown.code, 'unknown-op');
});

// The operation that throws is `memory.journal.read` over a journal that fails.
test('ops: an exception becomes failed with its code', async () => {
  const journal = {
    read: async () => {
      throw Object.assign(new Error('disk unreadable'), { code: 'EIO' });
    },
  };
  const env = makeEnv({ journal });
  const result = await runOp('memory.journal.read', {}, { env, placeId: 'g1', accountId: '42' });
  assert.deepEqual(result, { status: 'failed', code: 'EIO', summary: 'disk unreadable', data: null });

  const plain = makeEnv({
    journal: {
      read: async () => {
        throw new Error('boom');
      },
    },
  });
  const other = await runOp('memory.journal.read', {}, { env: plain, placeId: 'g1', accountId: '42' });
  assert.equal(other.status, 'failed');
  assert.equal(other.code, 'error');
});

test('ops: no memory refresh, forget, wipe or purge operation is left', () => {
  const ops = listOps();
  const gone = ['memory.refresh', 'memory.forget', 'memory.wipe', 'memory.private.forget', 'memory.private.purge'];
  assert.deepEqual(
    ops.filter((op) => gone.some((name) => op.name === name || op.name.startsWith(`${name}.`))).map((op) => op.name),
    []
  );
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['42']);

// `/memory inspect` and the domain routes from the owner's line to the answer, over the real memory service. The whole
// database is reachable through a snapshot the console holds for the owner: every table, every row, full values and a complete
// export. Only the `cli` principal reaches them, no tool of the persona does, and nothing they read is written anywhere. Plan
// 2026-11-04-cli-and-memory task 10; S9 reruns the discovery and the export over every new table and FTS shadow. A locator and
// a filter list are one JSON word. An answer is JSON; a refusal has a status other than `ok` and a `code`.

const rigs: Array<TestMemory> = [];
describe('memory inspection commands', () => {
  after(async () => {
    for (const memory of rigs) await memory.close();
  });

  test('no operation of the persona reaches the browser', () => {
    // Bug: an inspection registered as an operation becomes a tool the persona can be granted, and audience rules are bypassed.
    const names = JSON.stringify(listOps());
    for (const word of ['memory.inspect', 'memory.graph', 'memory.users', 'memory.places', 'inspection'])
      assert.equal(names.includes(word), false, word);
  });
});

// The owner's browser over semantic memory, from the owner's line to the answer, over the real memory service and a database the
// one writer filled (tests/fixtures/memory-db/semantic-world.ts). Plan 2026-11-04-cli-and-memory task 10.2 and the S9
// gate. `/memory entities list`, `show`, `names` and `relations` answer the typed reader of src/memory/db/entities-read.ts.
// `/memory claims` opens a semantic version with its roles, premise versions and exact sources, and the users, places and
// graph views reach the same records. `/memory inspect` reads and exports every semantic table and FTS shadow. Every read
// runs in the owner's internal context. A chat line and argv words select the same typed ids, and no read calls a model,
// writes a row or rebuilds a projection. Each audience test opens the DM's record through the internal context first, so
// what a group context misses is refused and never unwritten. Synthetic content only.
//
// The contract this file is typed against, beside tests/src/memory/db/entities-read.test.ts:
//   /memory entities list [--kind] [--name] [--recorded-before] [--limit] [--cursor]   args: kind, name, recorded-before
//   /memory entities show <entity> [--recorded-before]                                 args: entity
//   /memory entities names <entity>                                                    answers { names }
//   /memory entities relations <entity> [--predicates] [--mode] [--recorded-before] [--limit] [--cursor]
//   An entity nobody may read answers `invalid` with the code ENTITY_NOT_FOUND.
//   domainDetail of a semantic claim version adds `semantic: { assertion, arguments, dependencies }`, catalog rows of
//   `semantic_assertion_versions`, `semantic_arguments` and `semantic_dependencies`, and links each premise version
//   (role `premise`) and each version resting on it (role `dependent`). A plain version has no `semantic`.
//   personDetail and placeDetail list a semantic version whose reference argument names the person or the place as
//   `{ table: 'semantic_assertion_versions', id }` among their records.
//   The chat's bare `/memory entities` is a panel over `memory.entities.list`, each row prefilling
//   `/memory entities show <id>`.

const commandsMemorySemanticRigs: Array<TestMemory> = [];
describe('semantic memory commands', () => {
  after(async () => {
    for (const memory of commandsMemorySemanticRigs) await memory.close();
  });

  // ---- who reaches the routes ------------------------------------------------------------------------------------------

  test('no operation of the persona names the entity routes', () => {
    // Bug: an entity read registered as an operation becomes a tool the persona can be granted, past the audience rules.
    assert.equal(JSON.stringify(listOps()).includes('memory.entities'), false);
  });
});
