// The admin rig of the operation tests: a temp root with a base rules file, a fake hot settings object and an admin
// over the turn world's reads and port.

import fs from 'node:fs';
import path from 'node:path';
import { createAdmin } from '../../src/admin.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { createDiscordInterface } from '../../interfaces/discord/index.ts';
import { localPath } from './config-local.ts';
import { tempDir } from './tmp.ts';
import { world } from './turn-world.ts';
import { makeStore } from './admin-store.ts';
import type { StoreFake } from './admin-store.ts';
import { OWNER_PERSON, ownedBy } from './owner-accounts.ts';
import { chainsOf } from './chains.ts';

const DISCORD = createDiscordInterface().capabilities;

export function makeRoot(): string {
  const rootDir = tempDir('nep-admin-');
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  fs.writeFileSync(path.join(rootDir, 'prompts', 'rules.md'), '## Rules\n\n- be kind\n');
  return rootDir;
}

/** The fake hot settings an admin reads, with counters of its reloads. */
export type Hot = {
  config: Record<string, Untyped>;
  prompts: Record<string, Untyped>;
  promptSources: Record<string, string>;
  promptsDir: string;
  localPromptsDir: string;
  rootDir: string;
  reloadConfigCalls: number;
  reloadPromptsCalls: number;
  reloadConfig(this: Record<string, Untyped>): boolean;
  reloadPrompts(this: Record<string, Untyped>): boolean;
};

export function makeHot(rootDir: string): Hot {
  return {
    config: {
      bot: { ownerPerson: OWNER_PERSON },
      models: { routes: chainsOf({ core: 'anthropic/claude-opus-4.6' }) },
      llm: { maxRequestsPerDay: 300 },
    },
    prompts: { persona: 'who she is', labels: { locale: 'en-US' } },
    promptSources: { persona: 'base', labels: 'base' },
    promptsDir: path.join(rootDir, 'prompts'),
    localPromptsDir: path.join(rootDir, 'prompts.local'),
    rootDir,
    reloadConfigCalls: 0,
    reloadPromptsCalls: 0,
    reloadConfig(this: Record<string, Untyped>) {
      this.reloadConfigCalls += 1;
      return true;
    },
    reloadPrompts(this: Record<string, Untyped>) {
      this.reloadPromptsCalls += 1;
      return true;
    },
  };
}

// PR 7b: admin.isAllowed is gone; a caller may run `op` when runSkillOp, which checks the rights, does not deny it.
export const mayRun = async (
  admin: ReturnType<typeof createAdmin>,
  op: string,
  caller: Record<string, unknown>
): Promise<boolean> =>
  (await admin.runSkillOp(op, {}, { placeId: 'g1', roleIds: [], ...caller })).status !== 'denied';

/** The dependencies a test may hand the admin, each left out when the test gives none. */
const PASSED = [
  'reads',
  'port',
  'selfId',
  'getSelfName',
  'calibrator',
  'turns',
  'memory',
  'pending',
  'images',
  'imageFetcher',
  'emojiBackfill',
  'gifBackfill',
  'gifRecache',
  'archive',
  'journal',
  'llm',
  'embedder',
  'embedQueue',
  'record',
  'metrics',
  'lookup',
  'usage',
  'errands',
  'managementKey',
  'now',
] as const;

export type AdminExtra = { hot?: Hot; store?: object } & Record<string, Untyped>;

export function makeAdmin(
  rootDir: string,
  extra: AdminExtra = {}
): { admin: ReturnType<typeof createAdmin>; hot: Hot; store: StoreFake } {
  const hot = extra.hot ?? makeHot(rootDir);
  // A test that passes its own store reads that one, never the store this returns.
  const store = (extra.store ?? makeStore()) as StoreFake;
  const passed: Record<string, unknown> = {
    reads: world().reads,
    port: world().port,
    selfId: () => 'self-id',
    getSelfName: () => 'Persona',
    calibrator: { ratio: 1 },
  };
  for (const key of PASSED) passed[key] = (extra[key] as unknown) ?? passed[key];
  const admin = createAdmin({ discord: DISCORD, hot, store, ...passed });
  return { admin, hot, store };
}

/** The private settings file of `rootDir`, parsed. */
export function readLocal(rootDir: string): Untyped {
  return JSON.parse(fs.readFileSync(localPath(rootDir), 'utf8'));
}

/** The hot settings of `makeHot` with a memory and a media section and a vision model. */
export function makeHotWithMedia(rootDir: string): Hot {
  const hot = makeHot(rootDir);
  hot.config.memory = {};
  hot.config.media = {};
  // Changed: a role's model is its chain's (spec 2026-11-09-model-routes, slice 4).
  const models = hot.config.models as { routes: Record<string, unknown> };
  hot.config.models = { ...models, routes: { ...models.routes, ...chainsOf({ vision: 'anthropic/claude-haiku-4.5' }) } };
  return hot;
}

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['42']);
