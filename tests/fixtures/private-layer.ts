// A deployment's private layer on a temporary folder, for the tests of the tools that move its files: write files into
// it, read them back, and run tools/tools-file-move.mjs on it. The tool finds the folder through NEPTUNIA_PRIVATE_DIR,
// as every tool under tools/ does. Nothing here touches a real local layer.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export type Layer = {
  dir: string;
  /** Writes `value` as JSON to `rel` under the layer, making the folders on the way. */
  write: (rel: string, value: unknown) => void;
  /** The JSON in `rel`, or null when the file is absent. */
  json: (rel: string) => unknown;
  /** The bytes of `rel`, or null when the file is absent. */
  bytes: (rel: string) => string | null;
};

export function layer(): Layer {
  const dir = tempDir('nep-layer-');
  const at = (rel: string) => path.join(dir, rel);
  return {
    dir,
    write(rel, value) {
      fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
      fs.writeFileSync(at(rel), `${JSON.stringify(value, null, 2)}\n`);
    },
    json: (rel) => (fs.existsSync(at(rel)) ? (JSON.parse(fs.readFileSync(at(rel), 'utf8')) as unknown) : null),
    bytes: (rel) => (fs.existsSync(at(rel)) ? fs.readFileSync(at(rel), 'utf8') : null),
  };
}

/** Runs the move tool on `layer` with `flags`. */
export function moveTool(target: Layer, flags: Array<string>): { code: number | null; out: string; err: string } {
  const run = spawnSync(process.execPath, ['tools/tools-file-move.mjs', ...flags], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NEPTUNIA_PRIVATE_DIR: target.dir },
  });
  return { code: run.status, out: run.stdout, err: run.stderr };
}
