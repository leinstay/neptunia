// A skill's whole package: `SKILL.md`, `setup.json` and `scripts/`. `packageHash` makes one content hash of all of them,
// so an edited script is a new candidate version like an edited text, and nothing runs until it is activated.
// `snapshotPackage` keeps an immutable copy per hash under `.versions/<hash>/`, and `skill.run` runs the activated
// version's copy, so an edit never changes what runs. A skill with only a `SKILL.md` keeps the hash of its text. Called by
// load.ts and src/tools/impl/skill.ts.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SETUP_FILE = 'setup.json';
const SCRIPTS_DIR = 'scripts';
const VERSIONS_DIR = '.versions';

export type ScriptArg = { type: 'string' | 'number' | 'boolean' | 'object'; required: boolean };
export type ScriptManifest = { args: Record<string, ScriptArg>; credentials: Array<string> };

function filesUnder(dir: string, prefix = ''): Array<string> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? filesUnder(path.join(dir, entry.name), `${prefix}${entry.name}/`)
        : entry.isFile()
          ? [`${prefix}${entry.name}`]
          : []
    )
    .sort();
}

function extraFilesOf(skillDir: string): Array<string> {
  const setup = fs.existsSync(path.join(skillDir, SETUP_FILE)) ? [SETUP_FILE] : [];
  return [...setup, ...filesUnder(path.join(skillDir, SCRIPTS_DIR), `${SCRIPTS_DIR}/`)];
}

/** The hash of the package, or `textHash` when the skill is its text alone. */
export function packageHash(skillDir: string, text: string, textHash: string): string {
  const extra = extraFilesOf(skillDir);
  if (extra.length === 0) return textHash;
  const hash = createHash('sha256').update(text);
  for (const file of extra) hash.update(`\0${file}\0`).update(fs.readFileSync(path.join(skillDir, file)));
  return hash.digest('hex');
}

/** The folder of a version's immutable copy. */
export function snapshotDir(skillDir: string, hash: string): string {
  return path.join(skillDir, VERSIONS_DIR, hash);
}

/** Copies the package once per hash; a copy interrupted before its rename is never used. */
export function snapshotPackage(skillDir: string, text: string, hash: string): void {
  const target = snapshotDir(skillDir, hash);
  if (fs.existsSync(target)) return;
  const temp = `${target}.${process.pid}.tmp`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(temp, 'SKILL.md'), text);
  for (const file of extraFilesOf(skillDir)) {
    fs.mkdirSync(path.dirname(path.join(temp, file)), { recursive: true });
    fs.copyFileSync(path.join(skillDir, file), path.join(temp, file));
  }
  fs.renameSync(temp, target);
}

export type PackageCode = 'bad-setup' | 'missing-script' | 'undeclared-script';

/**
 * The first thing that keeps a package from running, or null: `setup.json` that does not parse, a declared script with
 * no file, or a script file `skill.run` would refuse because `setup.json` does not declare it. A helper in a subfolder
 * of `scripts/` is not a script. A package of `SKILL.md` alone is complete.
 */
export function packageProblem(skillDir: string): PackageCode | null {
  const onDisk = filesUnder(path.join(skillDir, SCRIPTS_DIR)).filter((file) => !file.includes('/'));
  const file = path.join(skillDir, SETUP_FILE);
  let declared: Array<string> = [];
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { scripts?: Record<string, unknown> } | null;
      declared = Object.keys(parsed?.scripts ?? {});
    } catch {
      return 'bad-setup';
    }
  }
  if (declared.some((name) => !onDisk.includes(name))) return 'missing-script';
  if (onDisk.some((name) => !declared.includes(name))) return 'undeclared-script';
  return null;
}

/** What `setup.json` declares for one script of a snapshot, or null when it declares no such script. */
export function scriptManifest(packageDir: string, script: string): ScriptManifest | null {
  const file = path.join(packageDir, SETUP_FILE);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { scripts?: Record<string, unknown> };
  const raw = parsed.scripts?.[script] as { args?: Record<string, ScriptArg>; credentials?: Array<string> } | undefined;
  if (raw === undefined) return null;
  return { args: raw.args ?? {}, credentials: Array.isArray(raw.credentials) ? raw.credentials : [] };
}

/** The first thing wrong with `args` against the manifest, or null. A key the manifest does not name is refused. */
export function argsProblem(manifest: ScriptManifest, args: Record<string, unknown>): string | null {
  for (const key of Object.keys(args)) if (!Object.hasOwn(manifest.args, key)) return `unknown argument ${key}`;
  for (const [key, want] of Object.entries(manifest.args)) {
    const value = args[key];
    if (value === undefined) {
      if (want.required) return `${key} is required`;
    } else if (typeof value !== want.type) return `${key} must be a ${want.type}`;
  }
  return null;
}
