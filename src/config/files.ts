// Runtime personal settings and labels use data/config. Interface settings use data/interfaces/<name>/config.json.
// The engine supplies shared config defaults.

import fs from 'node:fs';
import path from 'node:path';

/** The tracked folder of the settings, the labels and the tool texts, under the checkout. */
export const CONFIG_DIR = 'config';
/** The legacy private configuration folder, used by explicit offline converters. */
export const LOCAL_CONFIG_DIR = 'config.local';
/** The settings file's name in both folders. */
export const CONFIG_FILE = 'config.json';
/** The labels file's name in both folders. */
export const LABELS_FILE = 'labels.json';

/** The private files a layer has, each at its place or absent. */
export type LocalFiles = {
  /** The absolute path of the settings file the loader reads, or null when the layer has none. */
  config: string | null;
  /** The absolute path of the labels file the loader reads, or null when the layer has none. */
  labels: string | null;
};

/** Runtime configuration and labels belong to the canonical persona data root. */
export function localFiles(privateDir: string): LocalFiles {
  const at = (file: string): string | null => (fs.existsSync(file) ? file : null);
  return {
    config: at(path.join(privateDir, CONFIG_DIR, CONFIG_FILE)),
    labels: at(path.join(privateDir, CONFIG_DIR, LABELS_FILE)),
  };
}

/** The targeted writer uses exactly the same canonical settings file as the reader. */
export function localConfigPath(privateDir: string): string {
  return path.join(privateDir, CONFIG_DIR, CONFIG_FILE);
}

/** The absolute path of the tracked settings file under the checkout `rootDir`. */
export function trackedConfigPath(rootDir: string): string {
  return path.join(rootDir, CONFIG_DIR, CONFIG_FILE);
}

type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `over` laid on `base`: objects merge key by key, anything else in `over` replaces. */
function layered(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isTree(base) || !isTree(over)) return over;
  const result: Tree = { ...base };
  for (const [key, value] of Object.entries(over)) result[key] = layered(base[key], value);
  return result;
}

/** The JSON object in `file`, or an empty one when the file is absent or empty. Throws on JSON that does not parse. */
function readTree(file: string | null): Tree {
  if (file === null || !fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw === '') return {};
  const parsed: unknown = JSON.parse(raw);
  return isTree(parsed) ? parsed : {};
}

/** The private file of the interface `name`, under the private directory. */
export function localInterfacePath(privateDir: string, name: string): string {
  return path.join(privateDir, 'interfaces', name, CONFIG_FILE);
}

/** Authored persona packages replace the matching engine package when they have an entry point. */
export function interfacePackageDir(rootDir: string, dataDir: string, name: string): string {
  const personal = path.join(dataDir, 'interfaces', name);
  return ['index.ts', 'index.js'].some((file) => fs.existsSync(path.join(personal, file)))
    ? personal
    : path.join(rootDir, 'interfaces', name);
}

/** One interface receives only its own platform token, independently of core model credentials. */
export function interfaceCredential(dataDir: string, name: string): string | null {
  try {
    const value: unknown = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'interfaces', name, 'credentials.json'), 'utf8')
    );
    if (!value || typeof value !== 'object' || !('token' in value)) return null;
    return typeof value.token === 'string' && value.token !== '' ? value.token : null;
  } catch {
    return null;
  }
}

/** Core settings, then package defaults, then the canonical personal interface file. */
export function readInterfaceConfig(args: {
  rootDir: string;
  privateDir: string;
  name: string;
  base: Record<string, unknown>;
  packageDir?: string;
}): Record<string, unknown> {
  const { rootDir, privateDir, name, base } = args;
  const own = readTree(path.join(args.packageDir ?? interfacePackageDir(rootDir, privateDir, name), CONFIG_FILE));
  const local = readTree(localInterfacePath(privateDir, name));
  const merged = [own, local].reduce<unknown>((into, layer) => layered(into, layer), base);
  return isTree(merged) ? merged : {};
}
