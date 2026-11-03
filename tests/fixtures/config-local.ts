// The private settings file of a test layer: config/config.json, which the admin's writer makes when the layer
// has none (PR 7c).
import fs from 'node:fs';
import path from 'node:path';

export function localPath(rootDir: string): string {
  return path.join(rootDir, 'data', 'config', 'config.json');
}

/** `localPath`, its folder made, for a test that writes the file before the admin does. */
export function madeLocalPath(rootDir: string): string {
  fs.mkdirSync(path.join(rootDir, 'data', 'config'), { recursive: true });
  return localPath(rootDir);
}
