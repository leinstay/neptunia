// The private settings file of a test layer: config.local/config.json, which the admin's writer makes when the layer
// has none (PR 7c).
import fs from 'node:fs';
import path from 'node:path';

/** @param {string} rootDir */
export function localPath(rootDir) {
  return path.join(rootDir, 'config.local', 'config.json');
}

/**
 * `localPath`, its folder made, for a test that writes the file before the admin does.
 * @param {string} rootDir
 */
export function madeLocalPath(rootDir) {
  fs.mkdirSync(path.join(rootDir, 'config.local'), { recursive: true });
  return localPath(rootDir);
}
