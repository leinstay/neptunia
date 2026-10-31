// Where the settings and the labels live. The checkout holds `config/config.json` and `config/labels.json`, the
// private layer `config.local/config.json` and `config.local/labels.json`. A private layer laid out the old way, with
// `config.local.json` and a flat `prompts.local/labels.json`, still loads until tools/config-files-move.mjs moves it,
// and a layer holding a file at both places is refused. The loader (src/config.js, src/hot.js), the writer of
// `/config set` (src/tools/impl/env.ts), the console's `/config show` and `/config check` and `neptunia doctor` ask this
// module which file to read.

import fs from 'node:fs';
import path from 'node:path';

/** The tracked folder of the settings, the labels and the tool texts, under the checkout. */
export const CONFIG_DIR = 'config';
/** The private folder of the same three files, under the private directory. */
export const LOCAL_CONFIG_DIR = 'config.local';
/** The settings file's name in both folders. */
export const CONFIG_FILE = 'config.json';
/** The labels file's name in both folders. */
export const LABELS_FILE = 'labels.json';
/** The tool that moves a layer laid out the old way. */
export const MOVE_TOOL = 'tools/config-files-move.mjs';
/** The private settings file of the old layout, under the private directory. */
export const OLD_LOCAL_CONFIG = 'config.local.json';
/** The flat private labels file of the old layout, under the private directory. */
export const OLD_LOCAL_LABELS = path.join('prompts.local', LABELS_FILE);

/** The private files a layer has: each at its new place, at its old one, or absent. */
export type LocalFiles = {
  /** The absolute path of the settings file the loader reads, or null when the layer has none. */
  config: string | null;
  /** The labels file the loader reads with its shape, or null when the layer has none. */
  labels: { file: string; shape: 'split' | 'flat' } | null;
  /** Whether a file sits at its old place. */
  old: boolean;
};

/** Throws, naming the move tool, when both `oldRel` and `newRel` exist under `privateDir`. */
function refuseBoth(privateDir: string, oldRel: string, newRel: string): void {
  if (fs.existsSync(path.join(privateDir, oldRel)) && fs.existsSync(path.join(privateDir, newRel)))
    throw new Error(
      `${oldRel} and ${newRel} are both in ${privateDir}: run node ${MOVE_TOOL} --private <dir> --apply, ` +
        'which keeps one when they agree and names the one to resolve when they differ'
    );
}

/** Which private settings and labels files `privateDir` holds. Throws when a file is at both its places. */
export function localFiles(privateDir: string): LocalFiles {
  const newConfig = path.join(LOCAL_CONFIG_DIR, CONFIG_FILE);
  const newLabels = path.join(LOCAL_CONFIG_DIR, LABELS_FILE);
  refuseBoth(privateDir, OLD_LOCAL_CONFIG, newConfig);
  refuseBoth(privateDir, OLD_LOCAL_LABELS, newLabels);
  const at = (rel: string): string | null =>
    fs.existsSync(path.join(privateDir, rel)) ? path.join(privateDir, rel) : null;
  const oldConfig = at(OLD_LOCAL_CONFIG);
  const oldLabels = at(OLD_LOCAL_LABELS);
  const splitLabels = at(newLabels);
  return {
    config: at(newConfig) ?? oldConfig,
    labels:
      splitLabels !== null
        ? { file: splitLabels, shape: 'split' }
        : oldLabels !== null
          ? { file: oldLabels, shape: 'flat' }
          : null,
    old: oldConfig !== null || oldLabels !== null,
  };
}

/**
 * The private settings file `/config set` writes: the one the loader reads, else `config.local/config.json`. Unlike
 * `localFiles` it never throws, so a write names the file the start would refuse.
 */
export function localConfigPath(privateDir: string): string {
  const oldFile = path.join(privateDir, OLD_LOCAL_CONFIG);
  const newFile = path.join(privateDir, LOCAL_CONFIG_DIR, CONFIG_FILE);
  return !fs.existsSync(newFile) && fs.existsSync(oldFile) ? oldFile : newFile;
}

/** The absolute path of the tracked settings file under the checkout `rootDir`. */
export function trackedConfigPath(rootDir: string): string {
  return path.join(rootDir, CONFIG_DIR, CONFIG_FILE);
}
