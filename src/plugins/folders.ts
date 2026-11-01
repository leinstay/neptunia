// The plugin folders: `plugins/` of the checkout (tracked) and `plugins.local/` of the private layer, each holding one
// folder per plugin with its `plugin.json`. Both are read at each call. A local plugin replaces the tracked one of the
// same name whole. A folder with no `plugin.json` is no plugin and no problem. A plugin whose file does not parse, or
// that declares a skill with no `skills/<skill>/SKILL.md`, is a problem and no plugin, and never stops the others.
// The control (control.ts), the registry's manifests and the skills wiring read plugins through here.

import fs from 'node:fs';
import path from 'node:path';
import { parseManifest } from './manifest.ts';
import type { ManifestCode } from './manifest.ts';
import type { PluginManifest } from '../protocol/plugin.ts';

export type LoadedPlugin = { manifest: PluginManifest; layer: 'tracked' | 'local'; dir: string; skillsDir: string };
export type PluginProblem = { dir: string; code: ManifestCode | 'unreadable' | 'skill-missing' };

const FILE = 'plugin.json';

type Layer = { plugins: Array<LoadedPlugin>; problems: Array<PluginProblem> };

function readLayer(root: string, layer: 'tracked' | 'local'): Layer {
  const out: Layer = { plugins: [], problems: [] };
  let entries: Array<fs.Dirent>;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // No folder is no plugin of this layer.
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.resolve(root, entry.name);
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, FILE), 'utf8');
    } catch (error) {
      // A folder with no plugin.json is not a plugin; one that cannot be read is named.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        out.problems.push({ dir: entry.name, code: 'unreadable' });
      continue;
    }
    const parsed = parseManifest(text, entry.name);
    if (!parsed.ok) {
      out.problems.push({ dir: entry.name, code: parsed.code });
      continue;
    }
    const skillsDir = path.join(dir, 'skills');
    const missing = parsed.manifest.skills.some((skill) => !fs.existsSync(path.join(skillsDir, skill, 'SKILL.md')));
    if (missing) out.problems.push({ dir: entry.name, code: 'skill-missing' });
    else out.plugins.push({ manifest: parsed.manifest, layer, dir, skillsDir });
  }
  return out;
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function loadPlugins(folders: { trackedDir: string; localDir: string }): {
  plugins: Array<LoadedPlugin>;
  problems: Array<PluginProblem>;
} {
  const tracked = readLayer(folders.trackedDir, 'tracked');
  const local = readLayer(folders.localDir, 'local');
  const named = new Map<string, LoadedPlugin>();
  for (const plugin of [...tracked.plugins, ...local.plugins]) named.set(plugin.manifest.name, plugin);
  return {
    plugins: [...named.values()].sort((a, b) => byName(a.manifest.name, b.manifest.name)),
    problems: [...tracked.problems, ...local.problems].sort((a, b) => byName(a.dir, b.dir)),
  };
}
