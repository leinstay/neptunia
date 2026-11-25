// The search operations of src/tools/operations/search.ts: the reads the persona makes only inside a turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runOp } from '../../../../src/tools/operations/index.ts';
import { createOpsEnv } from '../../../../src/tools/operations/env.ts';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { OWNER_PERSON, ownedBy } from '../../../fixtures/owner-accounts.ts';

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

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

test('a read the persona makes only inside a turn answers unsupported when run as an operation', async () => {
  // Catches: a command form that reads a page or a picture outside a turn, with no turn context to read for.
  for (const name of ['web.search', 'web.read', 'media.look', 'media.find']) {
    const result = await runOp(name, { query: 'x', url: 'https://example.org/' }, { placeId: 'g1' });
    assert.deepEqual([name, result.status, result.code], [name, 'failed', 'unsupported']);
  }
});

test('ops: conversation.read, a read the persona makes only inside a turn, answers unsupported when run as an operation', async () => {
  // Catches: a command form that reads a chat outside a turn, with no turn context to read for.
  const result = await runOp('conversation.read', { message: '1' }, { env: makeEnv(), placeId: 'g1' });
  assert.deepEqual([result.status, result.code], ['failed', 'unsupported']);
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['42']);
