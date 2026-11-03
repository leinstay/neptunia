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
import { runWatcher } from '../../src/watcher/run.ts';
import type { RunDeps } from '../../src/subharness/run.ts';
import { fixture, watcher } from './agent-overrides.ts';
import type { AgentPaths } from './agent-overrides.ts';
import { writeKeysFile } from './keys-file.ts';
import { reportText } from './watcher-rig.ts';

export const consumers: {
  engine: (deps: Parameters<typeof createAgentEngine>[0] & { agentPaths?: AgentPaths }) => ReturnType<typeof createAgentEngine>;
  client: (deps: Parameters<typeof createErrandClient>[0] & { agentPaths?: AgentPaths }) => ReturnType<typeof createErrandClient>;
  service: (deps: Parameters<typeof createErrandService>[0] & { agentPaths?: AgentPaths }) => ReturnType<typeof createErrandService>;
  store: (deps: Parameters<typeof createErrandStore>[0] & { agentPaths?: AgentPaths }) => ReturnType<typeof createErrandStore>;
  stores: (deps: Parameters<typeof createErrandStores>[0] & { agentPaths?: AgentPaths }) => ReturnType<typeof createErrandStores>;
  watcher: (deps: Parameters<typeof runWatcher>[0] & { promptFiles: Array<string> }) => ReturnType<typeof runWatcher>;
} = { engine: createAgentEngine, client: createErrandClient, service: createErrandService, store: createErrandStore,
  stores: createErrandStores, watcher: runWatcher };

export function consumerRig(): ReturnType<typeof fixture> & {
  privateDir: string;
  reportsDir: string;
  sharedWatcher: string;
  personalWatcher: string;
  promptFiles: Array<string>;
  calls: Array<{ name: string; brief: string; options: BackendRunOptions }>;
  subharness: RunDeps;
  profile: Profile;
} {
  const rig = fixture();
  const privateDir = path.join(rig.base, 'credentials');
  const reportsDir = path.join(rig.base, 'reports-elsewhere', 'reports');
  const sharedWatcher = path.join(rig.rootDir, 'agents', 'watcher', 'prompt.md');
  const personalWatcher = path.join(rig.dataDir, 'agents', 'watcher', 'prompt.md');
  rig.writeShared('watcher', watcher());
  fs.writeFileSync(sharedWatcher, 'SHARED-WATCHER-MARKER');
  fs.mkdirSync(path.dirname(personalWatcher), { recursive: true });
  fs.writeFileSync(personalWatcher, 'PERSONAL-WATCHER-MARKER');
  fs.mkdirSync(reportsDir, { recursive: true });
  // A prompt beside reports is a decoy. Reports do not select the persona root.
  fs.writeFileSync(path.join(reportsDir, '..', 'prompt.md'), 'REPORTS-DECOY-MARKER');
  fs.mkdirSync(path.join(privateDir, 'prompts.local'), { recursive: true });
  fs.writeFileSync(path.join(privateDir, 'prompts.local', 'agent-scout.md'), 'PRIVATE-DECOY-MARKER');
  writeKeysFile(privateDir, { subharness: {
    backends: ['codex', 'claude'], key: null, modes: { scout: 'read', watcher: 'read' },
    uses: { scout: 'codex', watcher: 'claude' },
    models: { scout: 'worker-selected-model', watcher: 'watcher-selected-model' },
    efforts: { scout: 'high', watcher: 'low' },
  } });
  const calls: Array<{ name: string; brief: string; options: BackendRunOptions }> = [];
  const subharness: RunDeps = {
    privateDir, denyDir: path.join(rig.base, 'deny'), hostEnv: { PATH: '/usr/bin' },
    backendFactory: (name) => ({ name, run: (brief, options) => {
      calls.push({ name, brief, options });
      return Promise.resolve({ ok: true, text: reportText(), exitCode: 0 });
    } }),
  };
  const sharedProfile = profileOf('scout');
  if (sharedProfile === null) throw new Error('the shared scout profile is required');
  const profile = { ...sharedProfile, promptFiles: [path.join(rig.shared, 'prompt.md')],
    defaultLimits: { ...rig.definition.limits } };
  return { ...rig, privateDir, reportsDir, sharedWatcher, personalWatcher,
    promptFiles: [personalWatcher, sharedWatcher], calls, subharness, profile };
}
