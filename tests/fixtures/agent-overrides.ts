// Synthetic agent trees and the approved public loader signatures support the overrides regression tests.
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentProfileError,
  agentSettings,
  listAgents,
  loadProfiles,
  profileOf,
} from '../../src/agent-runner/profiles.ts';
import type { AgentDefinition, AgentSettings, Profile } from '../../src/agent-runner/profiles.ts';
import { tempDir } from './tmp.ts';

export type AgentPaths = {
  rootDir?: string;
  dataDir?: string;
  env?: Record<string, string | undefined>;
};

// These references call the real exports. Optional arguments let the baseline run before its signatures expand.
export const agents: {
  listAgents: (options?: AgentPaths) => ReadonlyArray<AgentDefinition>;
  loadProfiles: (options?: AgentPaths) => Readonly<Record<string, Profile>>;
  agentSettings: (name: unknown, config: unknown, options?: AgentPaths) => AgentSettings | null;
  profileOf: (name: unknown, options?: AgentPaths) => Profile | null;
} = { listAgents, loadProfiles, agentSettings, profileOf };

export function fixture(): {
  base: string;
  rootDir: string;
  dataDir: string;
  shared: string;
  personal: string;
  definition: AgentDefinition;
  options: AgentPaths;
  override: (value: unknown) => void;
  writeShared: (name: string, value: unknown) => void;
  close: () => void;
} {
  const base = tempDir('agent-overrides-');
  const rootDir = path.join(base, 'engine');
  const dataDir = path.join(base, 'persona');
  const shared = path.join(rootDir, 'agents', 'scout');
  const personal = path.join(dataDir, 'agents', 'scout');
  const definition: AgentDefinition = {
    id: 'scout',
    description: 'A synthetic agent.',
    prompt: 'prompt.md',
    limits: { steps: 25, seconds: 300 },
    daily: { tasks: 40 },
  };
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'profile.json'), JSON.stringify(definition));
  fs.writeFileSync(path.join(shared, 'prompt.md'), 'shared marker');
  return {
    base,
    rootDir,
    dataDir,
    shared,
    personal,
    definition,
    options: { rootDir, dataDir, env: {} },
    override(value) {
      fs.mkdirSync(personal, { recursive: true });
      fs.writeFileSync(path.join(personal, 'profile.json'), JSON.stringify(value));
    },
    writeShared(name, value) {
      const folder = path.join(rootDir, 'agents', name);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'profile.json'), JSON.stringify(value));
    },
    close() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

export function profileError(agent: string, key: string): (error: unknown) => boolean {
  return (error) => error instanceof AgentProfileError && error.agent === agent && error.key === key;
}
