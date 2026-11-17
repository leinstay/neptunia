// Public consumer calls use the approved path options before the baseline signatures expand.
import fs from 'node:fs';
import path from 'node:path';
import { createAgentEngine } from '../../src/agent-runner/backend.ts';
import type { BackendRunOptions } from '../../src/agent-runner/backend.ts';
import type { Profile } from '../../src/agent-runner/profiles.ts';
import { profileOf } from '../../src/agent-runner/profiles.ts';
import { createErrandClient } from '../../src/errands/client.ts';
import { createErrandService } from '../../src/errands/service.ts';
import { createErrandStore, createErrandStores } from '../../src/errands/store.ts';
import type { RunDeps } from '../../src/subharness/run.ts';
import { fixture } from './agent-overrides.ts';
import type { AgentPaths } from './agent-overrides.ts';
import { writeKeysFile } from './keys-file.ts';

export const consumers: {
  engine: (deps: Parameters<typeof createAgentEngine>[0] & { agentPaths?: AgentPaths }) => ReturnType<typeof createAgentEngine>;
  client: (deps: Parameters<typeof createErrandClient>[0] & { agentPaths?: AgentPaths }) => ReturnType<typeof createErrandClient>;
  service: (deps: Parameters<typeof createErrandService>[0] & { agentPaths?: AgentPaths }) => ReturnType<typeof createErrandService>;
  store: (deps: Parameters<typeof createErrandStore>[0] & { agentPaths?: AgentPaths }) => ReturnType<typeof createErrandStore>;
  stores: (deps: Parameters<typeof createErrandStores>[0] & { agentPaths?: AgentPaths }) => ReturnType<typeof createErrandStores>;
} = { engine: createAgentEngine, client: createErrandClient, service: createErrandService, store: createErrandStore,
  stores: createErrandStores };

export function consumerRig(): ReturnType<typeof fixture> & {
  privateDir: string;
  calls: Array<{ name: string; brief: string; options: BackendRunOptions }>;
  subharness: RunDeps;
  profile: Profile;
} {
  const rig = fixture();
  const privateDir = path.join(rig.base, 'credentials');
  fs.mkdirSync(path.join(privateDir, 'prompts.local'), { recursive: true });
  fs.writeFileSync(path.join(privateDir, 'prompts.local', 'agent-scout.md'), 'PRIVATE-DECOY-MARKER');
  writeKeysFile(privateDir, { subharness: {
    backends: ['codex', 'claude'], key: null, modes: { scout: 'read' },
    uses: { scout: 'codex' },
    models: { scout: 'worker-selected-model' },
    efforts: { scout: 'high' },
  } });
  const calls: Array<{ name: string; brief: string; options: BackendRunOptions }> = [];
  const subharness: RunDeps = {
    privateDir, hostEnv: { PATH: '/usr/bin' },
    backendFactory: (name) => ({ name, run: (brief, options) => {
      calls.push({ name, brief, options });
      return Promise.resolve({ ok: true, text: 'done', exitCode: 0 });
    } }),
  };
  const sharedProfile = profileOf('scout');
  if (sharedProfile === null) throw new Error('the shared scout profile is required');
  const profile = { ...sharedProfile, promptFiles: [path.join(rig.shared, 'prompt.md')],
    defaultLimits: { ...rig.definition.limits } };
  return { ...rig, privateDir, calls, subharness, profile };
}
