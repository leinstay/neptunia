// The one way a tool lays extra prompt directories over the bot's prompts for a run
// (tools/replay.mjs --pair, --diary and --skills): a scratch root holding a copy of the bot's
// config files (config/ from the checkout, config.local/ and the private settings file from the private directory:
// NEPTUNIA_PRIVATE_DIR, else the checkout; tools/lib/cli.mjs#privateDirOf) and its tracked prompts/, with the given
// directories copied into prompts.local/ in order, read by src/hot.js exactly as the bot reads its own layers. A
// layer's labels.json is flat, as an old prompts.local/labels.json is: once the layers are laid, the flat labels are
// split by the tracked config/labels.json into config.local/labels.json (src/config/labels.ts), so the scratch root
// has the layout src/hot.js reads without a warning and the labels it joins are the ones the flat file holds.
// Nothing in the checkout changes; the caller closes the hot view and removes the scratch root. A
// layer that is a link (a separate checkout whose prompts.local/ links to the live one) is read
// through it and copied as files: nothing in the scratch root links back, so nothing written there
// reaches the source.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, privateDirOf } from './cli.mjs';
import { CONFIG_DIR, CONFIG_FILE, LABELS_FILE, LOCAL_CONFIG_DIR, localFiles } from '../../src/config/files.ts';
import { joinLabels, labelsFileOf, splitLabels } from '../../src/config/labels.ts';

/** The JSON files of a prompt layer src/hot.js deep-merges instead of replacing (its JSON_LAYERS). */
const JSON_LAYER_FILES = Object.freeze(['labels.json', 'tools.json']);

/** The folder of the scratch root a layer's JSON file ends in: the tool texts go to `config.local/`, the labels to `prompts.local/`. */
const LOCAL_DIR_OF = Object.freeze({ 'labels.json': 'prompts.local', 'tools.json': 'config.local' });

/** The JSON value of `file`, or a CliError naming it. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError(`replay-cli: ${file}: ${err?.message ?? 'not JSON'}`);
  }
}

/**
 * The flat labels the layers left in `<dir>/prompts.local/labels.json`, split into `<dir>/config.local/labels.json`: laid
 * over the private split labels already there when `mergeJson` is given, in their place otherwise.
 * @param {string} dir
 * @param {((base: object, override: object) => object)|null} mergeJson
 */
function settleLabels(dir, mergeJson) {
  const flatFile = path.join(dir, 'prompts.local', LABELS_FILE);
  if (!fs.existsSync(flatFile)) return;
  const splitFile = path.join(dir, LOCAL_CONFIG_DIR, LABELS_FILE);
  /** @type {unknown} */
  const flatFileValue = readJson(flatFile);
  const flat = labelsFileOf({ model: flatFileValue }).model;
  /** @type {unknown} */
  const splitValue = typeof mergeJson === 'function' && fs.existsSync(splitFile) ? readJson(splitFile) : {};
  const base = joinLabels(labelsFileOf(splitValue));
  const merged = typeof mergeJson === 'function' ? labelsFileOf({ model: mergeJson(base, flat) }).model : flat;
  const trackedFile = path.join(dir, CONFIG_DIR, LABELS_FILE);
  /** @type {unknown} */
  const trackedValue = fs.existsSync(trackedFile) ? readJson(trackedFile) : {};
  const tracked = labelsFileOf(trackedValue);
  fs.writeFileSync(splitFile, `${JSON.stringify(splitLabels(merged, tracked), null, 2)}\n`);
  fs.rmSync(flatFile);
}

/**
 * A hot view (src/hot.js#createHot) over a scratch root: `root`'s config/, the config.local/ and the private settings
 * file of its private directory (privateDirOf(root, env)), its prompts/, and every
 * directory of `layers` (resolved against `root`) copied into prompts.local/ one after another, so
 * a later layer's file replaces an earlier one of the same name whole -- labels.json and
 * tools.json (laid into config.local/) included, unless `mergeJson` is given (src/config.js#deepMerge): then a later layer's
 * JSON layer file is deep-merged over the one already there, as src/hot.js merges prompts.local/
 * over prompts/. A layer that is not a directory, or a JSON layer file that does not parse when it
 * is merged, is a CliError. A layer given as a link is resolved (realpath) and every link inside it
 * followed: the copy holds files only, so the merge's writes and the hot view never reach the
 * source.
 * @param {(options: { rootDir: string }) => object} createHot
 * @param {string} root  The bot's checkout.
 * @param {string[]} layers
 * @param {{ tmpDir?: string, mergeJson?: ((base: object, override: object) => object)|null, env?: Record<string, string | undefined> }} [options]
 * @returns {{ hot: object, dir: string }}
 */
export function promptLayersHot(
  createHot,
  root,
  layers,
  { tmpDir = os.tmpdir(), mergeJson = null, env = process.env } = {}
) {
  const sources = layers.map((layer) => {
    const source = path.resolve(root, layer);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory())
      throw new CliError(`replay-cli: ${layer} is not a directory`);
    return fs.realpathSync(source);
  });
  const dir = fs.mkdtempSync(path.join(tmpDir, 'nep-prompt-layers-'));
  try {
    const privateDir = privateDirOf(root, env);
    // The private files as the engine finds them (src/config/files.ts), the old layout's included.
    const found = localFiles(privateDir);
    for (const folder of ['prompts', 'config']) {
      if (!fs.existsSync(path.join(root, folder))) continue;
      fs.cpSync(fs.realpathSync(path.join(root, folder)), path.join(dir, folder), {
        recursive: true,
        dereference: true,
      });
    }
    const local = path.join(dir, 'prompts.local');
    fs.mkdirSync(local, { recursive: true });
    fs.mkdirSync(path.join(dir, LOCAL_CONFIG_DIR), { recursive: true });
    if (fs.existsSync(path.join(privateDir, LOCAL_CONFIG_DIR))) {
      fs.cpSync(fs.realpathSync(path.join(privateDir, LOCAL_CONFIG_DIR)), path.join(dir, LOCAL_CONFIG_DIR), {
        recursive: true,
        dereference: true,
      });
    }
    if (found.config !== null) fs.copyFileSync(found.config, path.join(dir, LOCAL_CONFIG_DIR, CONFIG_FILE));
    /**
     * Where the layer file `name` rests in the scratch root.
     * @param {'labels.json' | 'tools.json'} name
     */
    const placed = (name) => path.join(dir, LOCAL_DIR_OF[name], name);
    for (const source of sources) {
      // With mergeJson, a JSON layer file meeting one already laid down is merged over it: the one
      // there is read before the copy and the merge written after it.
      const kept =
        typeof mergeJson === 'function'
          ? JSON_LAYER_FILES.filter(
              (name) => fs.existsSync(path.join(source, name)) && fs.existsSync(placed(name))
            ).map((name) => [name, readJson(placed(name))])
          : [];
      fs.cpSync(source, local, { recursive: true, force: true, dereference: true });
      // The tool texts of a layer rest where src/hot.js reads them, not among the prompt files.
      if (fs.existsSync(path.join(local, 'tools.json'))) {
        fs.renameSync(path.join(local, 'tools.json'), placed('tools.json'));
      }
      for (const [name, base] of kept) {
        const value = mergeJson(base, readJson(path.join(source, name)));
        fs.writeFileSync(placed(name), `${JSON.stringify(value, null, 2)}\n`);
      }
    }
    settleLabels(dir, mergeJson);
    return { hot: createHot({ rootDir: dir }), dir };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
