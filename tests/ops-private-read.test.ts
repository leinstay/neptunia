// The owner operation over the private view (src/tools/impl/memory.ts), by person or by place, on a core with no community:
// it reads `privateByPerson` and `privateByPlace` through the memory service and needs no guild.
// Contract, plan 2026-11-04-cli-and-memory task 5:
//   runOp('memory.private.read', { person: personId } | { place: placeId }, context)
//   memoryDb.privateByPerson(personId, context), memoryDb.privateByPlace(placeId, context)
// Appendix entries: src/tools/impl/memory.ts, src/tools/impl/env.ts, src/interface/commands/console.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { runOp } from '../src/tools/impl/index.ts';
import { ANNA, seedOpaqueWorld } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function rig(): { env: ReturnType<typeof createOpsEnv>; memoryDb: MemoryDbService } {
  const dataDir = tempDir('nep-ops-private-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedOpaqueWorld(dbOf(seed));
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const rootDir = tempDir('nep-ops-private-root-');
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  const hot = {
    config: { bot: { owners: [], access: {} }, llm: { model: 'x/y', maxRequestsPerDay: 10 } },
    prompts: { labels: {} },
    promptSources: {},
    promptsDir: path.join(rootDir, 'prompts'),
    localPromptsDir: path.join(rootDir, 'prompts.local'),
    rootDir,
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  const env = createOpsEnv({ hot, store: createStore({ dataDir, memoryDb }), memoryDb, dataDir });
  return { env, memoryDb };
}

const textOf = (result: { data?: unknown; message?: unknown; text?: unknown }): string => JSON.stringify(result);

test('the owner reads a person across all their DMs, with no community anywhere', async () => {
  // Bug: `requireGuildId` refuses first, then one community's unit of one account is all that is read.
  const { env } = rig();
  const result = await runOp('memory.private.read', { person: ANNA }, { env, asOwner: true });
  assert.equal(result.status, 'ok');
  const text = textOf(result);
  assert.ok(text.includes('the words of claim:a11'));
  assert.ok(text.includes('the event of episode:a21'));
  assert.equal(text.includes('the words of claim:b21'), false);
});

test('the owner reads one DM place and only that conversation', async () => {
  // Bug: the operation has only a user argument, so one conversation of a person cannot be inspected.
  const { env } = rig();
  const result = await runOp('memory.private.read', { place: 'place:dm-a21' }, { env, asOwner: true });
  assert.equal(result.status, 'ok');
  const text = textOf(result);
  assert.ok(text.includes('the event of episode:a21'));
  assert.equal(text.includes('the words of claim:a11'), false);
});

test('an unknown person and an unknown place answer their named codes', async () => {
  // Bug: a typo reads as an empty private memory.
  const { env } = rig();
  assert.equal(
    (await runOp('memory.private.read', { person: 'person:nobody' }, { env, asOwner: true })).code,
    'PERSON_NOT_FOUND'
  );
  assert.equal(
    (await runOp('memory.private.read', { place: 'place:nowhere' }, { env, asOwner: true })).code,
    'PLACE_NOT_FOUND'
  );
});

test('anyone but the owner is refused before anything is read', async () => {
  // Bug: the rights check moves behind the read, and a refusal tells how much there is.
  const { env } = rig();
  const result = await runOp('memory.private.read', { person: ANNA }, { env, accountId: '999', roleIds: [] });
  assert.equal(result.status, 'denied');
  assert.equal(result.code, 'owner-only');
});

test('the service answers the same views through its read connection', () => {
  // Bug: the operation opens the database itself, past the one writer and its read seam.
  const { memoryDb } = rig();
  const view = memoryDb.privateByPerson(ANNA, internalContext());
  assert.equal(view.found && view.person.id, ANNA);
  assert.equal(memoryDb.privateByPlace('place:nowhere', internalContext()).found, false);
});
