// Inspects and copies supported personal overrides into an isolated root for the offline persona migration script.
// Plans contain paths and codes only. Runtime loading and the source files remain unchanged.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AgentProfileError, listSharedAgents } from '../agent-runner/profiles.ts';
import { joinLabels, labelsFileOf, splitLabels } from '../config/labels.ts';
import { deepMerge, parseEnv } from '../config.ts';
import { CUT_KEYS, cutConfigKeys } from '../config/cut.ts';
import { importKeys } from '../keys/import.ts';
import { createKeyStore } from '../keys/store.ts';

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
type Material = { step: PersonaLayerStep; bytes: Buffer; value: unknown; format: Format; mode: number };
type Format = 'prompt' | 'bytes' | 'settings' | 'object' | 'labels' | 'flat';

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
  if (format === 'prompt' || format === 'bytes') return bytes;
  const value = parse(bytes, relative, format === 'settings' || format === 'flat');
  return format === 'labels' ? { ...value, ...sections(value, relative) } : value;
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
    for (const agent of listSharedAgents({ rootDir: root })) {
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
  const dir =
    isObject(effective) && typeof effective.dir === 'string' && effective.dir.trim() !== ''
      ? effective.dir.trim()
      : '.agents/watcher';
  return path.join(path.resolve(options.rootDir, dir), 'prompt.md');
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function merged(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const value: unknown = deepMerge(base, over);
  return isObject(value) ? value : {};
}

/** Remove only interface-owned legacy settings, preserving every unrelated core field. */
function withoutInterfaceSettings(value: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(value);
  for (const row of CUT_KEYS.filter((entry) => entry.becomes === 'discord')) {
    const parts = row.key.split('.');
    let node = result;
    const ancestors: Array<[Record<string, unknown>, string]> = [];
    for (const segment of parts.slice(0, -1)) {
      if (!isObject(node[segment])) break;
      ancestors.push([node, segment]);
      node = node[segment];
    }
    if (ancestors.length !== parts.length - 1) continue;
    const last = parts.at(-1);
    if (last !== undefined) delete node[last];
    for (const [parent, segment] of ancestors.reverse()) {
      if (isObject(parent[segment]) && Object.keys(parent[segment]).length === 0) delete parent[segment];
    }
  }
  return result;
}

/** Reuse the credential importer's role and grant rules without touching either migration root. */
function modelCredentials(env: Record<string, string>, config: Record<string, unknown>): Record<string, unknown> {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-key-import-'));
  try {
    importKeys({ env, config, store: createKeyStore({ privateDir: temporary }) });
    const file = path.join(temporary, 'keys.json');
    return fs.existsSync(file) ? parse(fs.readFileSync(file), '.env', false) : {};
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const SERVICES: ReadonlyArray<[string, string]> = [
  ['YOUTUBE_API_KEY', 'youtube'],
  ['BRAVE_SEARCH_API_KEY', 'brave'],
  ['EXA_API_KEY', 'exa'],
  ['MEDIA_VIDEO_PROXY', 'proxy'],
];

/** Material classification uses the declared persona directories, including complete native backend homes. */
function copiedFolder(source: string): string | null {
  if (source === 'skills.local') return 'skills';
  if (['agents', 'interfaces', 'clients', 'cli'].includes(source)) return source;
  return /^subharness\/(?:codex|claude|opencode)\/home$/.test(source) ? source : null;
}

type InterfaceLayer = { source: string; bytes: Buffer };
type InterfaceLayers = Partial<Record<'own' | 'legacy' | 'dedicated', InterfaceLayer>>;

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
  const interfaces = new Map<string, InterfaceLayers>();
  const layer = (name: string, kind: keyof InterfaceLayers, source: string, bytes: Buffer): void => {
    const layers = interfaces.get(name) ?? {};
    const previous = layers[kind];
    if (previous && !isDeepStrictEqual(parse(previous.bytes, previous.source, true), parse(bytes, source, true)))
      throw new InspectionError(source, 'different-content');
    layers[kind] = { source, bytes };
    interfaces.set(name, layers);
  };
  const propose = (
    source: string,
    target: string,
    bytes: Buffer,
    format: Format,
    mode = 0o600,
    kind: PersonaLayerStep['kind'] = 'copy',
    replace = false
  ): void => {
    const value = decoded(bytes, source, format);
    const previous = candidates.get(target);
    if (previous && !replace) {
      if (!isDeepStrictEqual(previous.value, value)) throw new InspectionError(source, 'different-content');
      return;
    }
    candidates.set(target, { step: { source, target, kind }, bytes, value, format, mode });
  };
  const add = (source: string, target: string, format: Format): void => {
    const sourceRoot = path.isAbsolute(source) ? path.dirname(source) : options.privateDir;
    const sourceFile = path.isAbsolute(source) ? path.basename(source) : source;
    let bytes = read(sourceRoot, sourceFile);
    let kind: PersonaLayerStep['kind'] = 'copy';
    if (format === 'flat') {
      const trackedPath = 'config/labels.json';
      const tracked = sections(parse(read(options.rootDir, trackedPath), trackedPath, false), trackedPath);
      bytes = jsonBytes(splitLabels(parse(bytes, source, true), tracked));
      format = 'labels';
      kind = 'split-labels';
    }
    if (format === 'settings') {
      const value = parse(bytes, source, true);
      const extracted = cutConfigKeys(value).interfaces;
      for (const [name, settings] of Object.entries(extracted)) layer(name, 'legacy', source, jsonBytes(settings));
      if (Object.keys(extracted).length > 0) bytes = jsonBytes(withoutInterfaceSettings(value));
    }
    const mode = format === 'bytes' ? 0o600 | (inspect(sourceRoot, sourceFile)!.mode & 0o111) : 0o600;
    propose(source, target, bytes, format, mode, kind);
  };
  const copyTree = (source: string, target: string): void => {
    const stat = inspect(options.privateDir, source);
    if (stat?.isDirectory()) {
      for (const name of entries(options.privateDir, source))
        copyTree(path.join(source, name), path.join(target, name));
    } else if (stat?.isFile()) {
      const own = /^interfaces\/([^/]+)\/config\.json$/.exec(source)?.[1];
      // Stage AB: a runner's environment file holds keys the runners no longer read.
      if (/^clients\/agent-(?:scout|server)\.env$/.test(source)) return;
      if (own) layer(own, 'own', source, read(options.privateDir, source));
      else add(source, target, 'bytes');
    } else throw new InspectionError(source, 'unreadable');
  };
  const credentials = (): void => {
    if (inspect(options.privateDir, '.env') === null) return;
    const env = parseEnv(read(options.privateDir, '.env').toString('utf8'));
    const existing = candidates.get('keys.json');
    const basePath = 'config/config.json';
    const base =
      inspect(options.rootDir, basePath) === null ? {} : parse(read(options.rootDir, basePath), basePath, true);
    const local = candidates.get(basePath)?.value;
    const config = merged(base, isObject(local) ? local : {});
    let keys = existing ? parse(existing.bytes, 'keys.json', false) : modelCredentials(env, config);
    let changed = !existing && Object.keys(keys).length > 0;
    for (const [variable, name] of SERVICES) {
      if (!env[variable]) continue;
      const services = isObject(keys.services) ? keys.services : {};
      if (!Object.hasOwn(services, name)) {
        keys = { ...keys, services: { ...services, [name]: env[variable] } };
        changed = true;
      }
    }
    if (changed) propose('.env', 'keys.json', jsonBytes(keys), 'object', 0o600, 'copy', true);
    if (env.DISCORD_TOKEN)
      propose('.env', 'interfaces/discord/credentials.json', jsonBytes({ token: env.DISCORD_TOKEN }), 'object');
    const known = new Set(['DISCORD_TOKEN', ...SERVICES.map(([variable]) => variable)]);
    for (const variable of Object.keys(env)) {
      if (!known.has(variable) && !/^OPENROUTER_[A-Z0-9_]+_KEY$/.test(variable))
        plan.held.push({ path: `.env:${variable}`, reason: 'unclassified' });
    }
  };
  const reconcileInterfaces = (): void => {
    for (const [name, layers] of interfaces) {
      const selected = layers.dedicated ?? layers.legacy ?? layers.own;
      if (!selected) continue;
      if (layers.own && !layers.legacy && !layers.dedicated) {
        add(layers.own.source, `interfaces/${name}/config.json`, 'bytes');
        continue;
      }
      const value = [layers.own, layers.legacy, layers.dedicated].reduce<Record<string, unknown>>(
        (result, next) => (next ? merged(result, parse(next.bytes, next.source, true)) : result),
        {}
      );
      propose(selected.source, `interfaces/${name}/config.json`, jsonBytes(value), 'object');
    }
  };
  const copyMaterial = (source: string, recurse: (folder: string) => void): boolean => {
    const destination = copiedFolder(source);
    const dedicated = /^config\.local\/interfaces\/([^/]+)\.json$/.exec(source)?.[1];
    if (destination) {
      copyTree(source, destination);
      return true;
    } else if (
      source === 'keys.json' ||
      source === 'clients.json' ||
      /^subharness\/(?:codex|claude|opencode)\/(?:package(?:-lock)?\.json|npm-shrinkwrap\.json)$/.test(source)
    ) {
      add(source, source, 'bytes');
      return true;
    } else if (source === '.env') {
      return true; // Credentials are classified after private configuration and key-store candidates.
    } else if (dedicated) {
      layer(dedicated, 'dedicated', source, read(options.privateDir, source));
      return true;
    } else if (
      source === 'subharness' ||
      /^subharness\/(?:codex|claude|opencode)$/.test(source) ||
      source === 'config.local/interfaces'
    ) {
      recurse(source);
      return true;
    }
    return false;
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
          if (copyMaterial(source, scan)) return;
          if (source === 'config.local' || source === 'prompts.local' || source === 'prompts.local/preambles') {
            scan(source);
          } else if (source === 'prompts.local/skills.json') {
            throw new InspectionError(source, 'legacy-tools');
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
    credentials();
    reconcileInterfaces();
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
        const format = material.format;
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
      fs.fchmodSync(descriptor, material.mode);
      fs.writeFileSync(descriptor, material.bytes);
    } finally {
      fs.closeSync(descriptor);
    }
    const existing = inspect(options.dataDir, target);
    if (existing !== null) {
      if (
        !existing.isFile() ||
        !isDeepStrictEqual(decoded(read(options.dataDir, target), target, material.format), material.value)
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
