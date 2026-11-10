// The owner operations and her tools on neutral contracts (src/tools/operations/env.ts and the families over it): an operation
// that addresses a place reads it from its context or its arguments. Nothing falls back to a home root.
// Contract, plan 2026-11-04-cli-and-memory task 5: `createOpsEnv` takes no `getRootId`; the env has no `requireRootId` or
// `resolvedRootId`; `OpContext.placeId` replaces `OpContext.rootId`; a place operation with no place refuses with code
// `PLACE_REQUIRED`.
// Appendix entries: src/tools/operations/{env,access,alias,draw,errand,index,inner,intention,learning,lore,media,memory,message,
// pause,pings,places,search,shared,status,voice}.ts, src/tools/{codes,conversation-read,executors,tools,types}.ts,
// src/turn/{act,calls,draw-gif,in-turn-tools,skill-calls,tool-round}.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { createStore } from '../src/memory/store.ts';

import { createOpsEnv } from '../src/tools/operations/env.ts';
import { runOp } from '../src/tools/operations/index.ts';
import { tempDir } from './fixtures/tmp.ts';

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function rig(): ReturnType<typeof createOpsEnv> {
  const dataDir = tempDir('nep-tools-neutral-');
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const rootDir = tempDir('nep-tools-neutral-root-');
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
  return createOpsEnv({ hot, store: createStore({ dataDir, memoryDb }), memoryDb, dataDir });
}

const owner = (env: ReturnType<typeof createOpsEnv>, placeId?: string) => ({
  env,
  asOwner: true,
  ...(placeId === undefined ? {} : { placeId }),
});

test('a place operation with a place in its context reads that place', async () => {
  // Bug: the context's place is ignored for the home root, so the owner reads the wrong server's lore.
  const env = rig();
  const added = await runOp(
    'lore.add',
    { title: 'of room one', keys: 'synthetic', text: 'a synthetic fact' },
    owner(env, 'place:room-1')
  );
  assert.equal(added.status, 'ok');
  const here = await runOp('lore.list', {}, owner(env, 'place:room-1'));
  assert.ok(JSON.stringify(here).includes('of room one'));
  const there = await runOp('lore.list', {}, owner(env, 'place:room-2'));
  assert.equal(JSON.stringify(there).includes('of room one'), false);
});

test('a place operation with no place is refused by name', async () => {
  // Bug: it falls back to a home root, or stores under an empty id that every such caller then shares.
  const result = await runOp('lore.list', {}, owner(rig()));
  assert.equal(result.code, 'PLACE_REQUIRED');
});

test('an operation of the persona needs no place at all', async () => {
  // Bug: `status.show` and the kill switch share the root prerequisite though they read no place.
  const result = await runOp('status.show', {}, owner(rig()));
  assert.equal(result.status, 'ok');
});
