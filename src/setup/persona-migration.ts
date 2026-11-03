// Inspects and copies supported personal overrides into an isolated root for the offline persona migration script.
// Plans contain paths and codes only. Runtime loading and the source files remain unchanged.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AgentProfileError, listAgents } from '../agent-runner/profiles.ts';
import { watcherDir } from '../watcher/read.ts';
import { joinLabels, labelsFileOf, splitLabels } from '../config/labels.ts';

export type PersonaLayerOptions = { rootDir: string; privateDir: string; dataDir: string };
export type PersonaLayerStep = { source: string; target: string; kind: 'copy' | 'split-labels' };
export type PersonaLayerIssue = {
  path: string;
  code: 'different-content' | 'invalid-json' | 'invalid-shape' | 'unreadable' | 'unsafe-path' | 'legacy-tools';
};
export type PersonaLayerHeld = { path: string; reason: 'agent-contract' | 'interface-contract' | 'unclassified' };
export type PersonaLayerPlan = {
  steps: Array<PersonaLayerStep>;
  unchanged: Array<string>;
  held: Array<PersonaLayerHeld>;
  conflicts: Array<PersonaLayerIssue>;
};
type Material = { step: PersonaLayerStep; bytes: Buffer; value: unknown };
type Format = 'prompt' | 'settings' | 'object' | 'labels' | 'flat';

class InspectionError extends Error {
  issue: PersonaLayerIssue;
  constructor(at: string, code: PersonaLayerIssue['code']) {
    super(`${at}: ${code}`);
    this.issue = { path: at, code };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function relativeSafe(relative: string): boolean {
  return relative !== '' && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..');
}

// Inspect ancestors too, including the root itself, before following any path.
function inspect(root: string, relative: string): fs.Stats | null {
  if (relative !== '' && !relativeSafe(relative)) throw new InspectionError(relative, 'unsafe-path');
  const full = path.resolve(root, relative);
  let current = path.parse(full).root;
  let stat: fs.Stats | null = null;
  for (const component of full.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (isObject(error) && error.code === 'ENOENT') return null;
      throw new InspectionError(relative || '.', 'unreadable');
    }
    if (stat.isSymbolicLink()) throw new InspectionError(relative || '.', 'unsafe-path');
    if (current !== full && !stat.isDirectory()) throw new InspectionError(relative || '.', 'unsafe-path');
  }
  return stat;
}

function read(root: string, relative: string): Buffer {
  const stat = inspect(root, relative);
  if (!stat?.isFile()) throw new InspectionError(relative, 'unreadable');
  try {
    return fs.readFileSync(path.join(root, relative));
  } catch {
    throw new InspectionError(relative, 'unreadable');
  }
}

function entries(root: string, relative: string): Array<string> {
  const stat = inspect(root, relative);
  if (stat === null) return [];
  if (!stat.isDirectory()) throw new InspectionError(relative || '.', 'unreadable');
  try {
    return fs.readdirSync(path.join(root, relative)).sort();
  } catch {
    throw new InspectionError(relative || '.', 'unreadable');
  }
}

function parse(bytes: Buffer, relative: string, blank: boolean): Record<string, unknown> {
  let value: unknown;
  try {
    const text = bytes.toString('utf8');
    value = blank && text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new InspectionError(relative, 'invalid-json');
  }
  if (!isObject(value)) throw new InspectionError(relative, 'invalid-shape');
  return value;
}

function sections(value: Record<string, unknown>, relative: string) {
  for (const key of ['model', 'owner']) {
    if (Object.hasOwn(value, key) && !isObject(value[key])) throw new InspectionError(relative, 'invalid-shape');
  }
  const split = labelsFileOf(value);
  try {
    joinLabels(split);
  } catch {
    throw new InspectionError(relative, 'invalid-shape');
  }
  return split;
}

function decoded(bytes: Buffer, relative: string, format: Format): unknown {
  if (format === 'prompt') return bytes;
  const value = parse(bytes, relative, format === 'settings' || format === 'flat');
  return format === 'labels' ? { ...value, ...sections(value, relative) } : value;
}

function targetFormat(target: string): Format {
  if (target === 'config/labels.json') return 'labels';
  if (target === 'config/config.json') return 'settings';
  return target.endsWith('.json') ? 'object' : 'prompt';
}

function agentOverrides(root: string): Map<string, Array<string>> {
  const overrides = new Map<string, Array<string>>();
  if (inspect(root, 'agents') === null) return overrides;
  for (const name of entries(root, 'agents')) {
    const folder = `agents/${name}`;
    if (!inspect(root, folder)?.isDirectory()) continue;
    const profile = `${folder}/profile.json`;
    const value = parse(read(root, profile), profile, false);
    for (const field of ['override', 'prompt']) {
      const file = value[field];
      if (typeof file === 'string' && (!relativeSafe(file) || /[\\/\0]/.test(file)))
        throw new InspectionError(profile, 'unsafe-path');
    }
  }
  try {
    for (const agent of listAgents({ rootDir: root })) {
      if (agent.override === null || agent.prompt === null) continue;
      const targets = overrides.get(agent.override) ?? [];
      targets.push(path.join('agents', agent.id, agent.prompt));
      overrides.set(agent.override, targets);
    }
  } catch (error) {
    if (error instanceof AgentProfileError)
      throw new InspectionError(`agents/${error.agent}/profile.json`, 'invalid-shape');
    throw error;
  }
  return overrides;
}

/** Select the watcher's legacy directory using the original engine root. */
function watcherPrompt(options: PersonaLayerOptions, personal: unknown): string {
  const trackedPath = 'config/config.json';
  const tracked =
    inspect(options.rootDir, trackedPath) === null ? {} : parse(read(options.rootDir, trackedPath), trackedPath, true);
  const local = isObject(personal) ? personal : {};
  const base = isObject(tracked.watcher) ? tracked.watcher : {};
  const effective = Object.hasOwn(local, 'watcher')
    ? isObject(local.watcher)
      ? { ...base, ...local.watcher }
      : local.watcher
    : base;
  return path.join(path.resolve(options.rootDir, watcherDir({ watcher: effective })), 'prompt.md');
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function inspection(options: PersonaLayerOptions): { plan: PersonaLayerPlan; materials: Array<Material> } {
  const plan: PersonaLayerPlan = { steps: [], unchanged: [], held: [], conflicts: [] };
  const candidates = new Map<string, Material>();
  const attempt = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      if (!(error instanceof InspectionError)) throw error;
      plan.conflicts.push(error.issue);
    }
  };
  const add = (source: string, target: string, format: Format): void => {
    const sourceRoot = path.isAbsolute(source) ? path.dirname(source) : options.privateDir;
    const sourceFile = path.isAbsolute(source) ? path.basename(source) : source;
    const bytes = read(sourceRoot, sourceFile);
    let value = decoded(bytes, source, format);
    let output = bytes;
    if (format === 'flat') {
      const trackedPath = 'config/labels.json';
      const tracked = sections(parse(read(options.rootDir, trackedPath), trackedPath, false), trackedPath);
      // The flat format has already passed the object check in decoded.
      value = splitLabels(parse(bytes, source, true), tracked);
      output = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    }
    const previous = candidates.get(target);
    if (previous) {
      if (!isDeepStrictEqual(previous.value, value)) throw new InspectionError(source, 'different-content');
      return;
    }
    candidates.set(target, {
      step: { source, target, kind: format === 'flat' ? 'split-labels' : 'copy' },
      bytes: output,
      value,
    });
  };
  attempt(() => {
    if (
      within(options.privateDir, options.dataDir) ||
      within(options.dataDir, options.privateDir) ||
      within(options.dataDir, options.rootDir)
    ) {
      throw new InspectionError('.', 'unsafe-path');
    }
    inspect(options.privateDir, '');
    inspect(options.dataDir, '');
    const overrides = agentOverrides(options.rootDir);
    const scan = (folder: string): void => {
      for (const name of entries(options.privateDir, folder)) {
        const source = path.join(folder, name);
        attempt(() => {
          inspect(options.privateDir, source);
          if (source === 'config.local' || source === 'prompts.local' || source === 'prompts.local/preambles') {
            scan(source);
          } else if (source === 'prompts.local/skills.json') {
            throw new InspectionError(source, 'legacy-tools');
          } else if (source === 'config.local/interfaces') {
            plan.held.push({ path: source, reason: 'interface-contract' });
          } else if (folder === 'prompts.local' && overrides.has(name)) {
            for (const target of overrides.get(name) ?? []) add(source, target, 'prompt');
          } else if (source.startsWith('prompts.local/') && name.startsWith('agent-')) {
            plan.held.push({ path: source, reason: 'agent-contract' });
          } else if (source === 'config.local/config.json' || source === 'config.local.json') {
            add(source, 'config/config.json', 'settings');
          } else if (source === 'config.local/labels.json') {
            add(source, 'config/labels.json', 'labels');
          } else if (source === 'config.local/tools.json') {
            add(source, 'config/tools.json', 'object');
          } else if (source === 'prompts.local/labels.json') {
            add(source, 'config/labels.json', 'flat');
          } else if ((folder === 'prompts.local' || folder === 'prompts.local/preambles') && name.endsWith('.md')) {
            add(source, path.join('prompts', path.relative('prompts.local', source)), 'prompt');
          } else {
            plan.held.push({ path: source, reason: 'unclassified' });
          }
        });
      }
    };
    scan('');
    const source = watcherPrompt(options, candidates.get('config/config.json')?.value);
    if (inspect(path.dirname(source), path.basename(source)) !== null)
      add(source, 'agents/watcher/prompt.md', 'prompt');
  });
  for (const material of candidates.values()) {
    attempt(() => {
      const target = material.step.target;
      const stat = inspect(options.dataDir, target);
      if (stat === null) plan.steps.push(material.step);
      else {
        const format = targetFormat(target);
        if (
          !stat.isFile() ||
          !isDeepStrictEqual(decoded(read(options.dataDir, target), target, format), material.value)
        ) {
          throw new InspectionError(target, 'different-content');
        }
        plan.unchanged.push(target);
      }
    });
  }
  plan.steps.sort((a, b) => a.source.localeCompare(b.source, 'en'));
  plan.held.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  plan.conflicts.sort((a, b) => a.path.localeCompare(b.path, 'en') || a.code.localeCompare(b.code, 'en'));
  plan.unchanged.sort();
  return {
    plan,
    materials: plan.steps.flatMap((step) => {
      const material = candidates.get(step.target);
      return material ? [material] : [];
    }),
  };
}

export function planPersonaLayers(options: PersonaLayerOptions): PersonaLayerPlan {
  return inspection(options).plan;
}

function makeDirectories(root: string, relative: string): void {
  const full = path.resolve(root, relative);
  if (inspect(full, '') !== null) return;
  makeDirectories(path.dirname(full), '');
  fs.mkdirSync(full, { mode: 0o700 });
  fs.chmodSync(full, 0o700);
}

function install(options: PersonaLayerOptions, material: Material): void {
  const target = material.step.target;
  let temporary: string | undefined;
  try {
    inspect(options.dataDir, target);
    makeDirectories(options.dataDir, path.dirname(target));
    const staged = path.join(options.dataDir, path.dirname(target), `.persona-${randomUUID()}`);
    const descriptor = fs.openSync(staged, 'wx', 0o600);
    temporary = staged;
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, material.bytes);
    } finally {
      fs.closeSync(descriptor);
    }
    const existing = inspect(options.dataDir, target);
    if (existing !== null) {
      if (
        !existing.isFile() ||
        !isDeepStrictEqual(decoded(read(options.dataDir, target), target, targetFormat(target)), material.value)
      ) {
        throw new InspectionError(target, 'different-content');
      }
    } else {
      fs.renameSync(staged, path.join(options.dataDir, target));
    }
  } finally {
    if (temporary !== undefined) fs.rmSync(temporary, { force: true });
  }
}

export function applyPersonaLayers(options: PersonaLayerOptions): PersonaLayerPlan {
  const { plan, materials } = inspection(options);
  if (plan.conflicts.length > 0) return plan;
  for (const material of materials) {
    try {
      install(options, material);
    } catch {
      throw new Error(`${material.step.target}: install-failed`);
    }
  }
  return plan;
}
