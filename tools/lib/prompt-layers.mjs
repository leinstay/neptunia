// The one way a tool lays extra prompt directories over the bot's prompts for a run
// (tools/replay.mjs --pair, --diary and --skills): a scratch root holding a copy of the bot's
// config files and its tracked prompts/, with the given directories copied into prompts.local/
// in order, read by src/hot.js exactly as the bot reads its own layers. Nothing in the checkout
// changes; the caller closes the hot view and removes the scratch root.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './cli.mjs';

/** The JSON files of a prompt layer src/hot.js deep-merges instead of replacing (its JSON_LAYERS). */
const JSON_LAYER_FILES = Object.freeze(['labels.json', 'skills.json']);

/** The JSON value of `file`, or a CliError naming it. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError(`replay-cli: ${file}: ${err?.message ?? 'not JSON'}`);
  }
}

/**
 * A hot view (src/hot.js#createHot) over a scratch root: `root`'s config.json and
 * config.local.json, its prompts/, and every directory of `layers` (resolved against `root`)
 * copied into prompts.local/ one after another, so a later layer's file replaces an earlier
 * one of the same name whole -- labels.json and skills.json included, unless `mergeJson` is
 * given (src/config.js#deepMerge): then a later layer's JSON layer file is deep-merged over the
 * one already there, as src/hot.js merges prompts.local/ over prompts/. A layer that is not a
 * directory, or a JSON layer file that does not parse when it is merged, is a CliError.
 * @param {(options: { rootDir: string }) => object} createHot
 * @param {string} root  The bot's checkout.
 * @param {string[]} layers
 * @param {{ tmpDir?: string, mergeJson?: ((base: object, override: object) => object)|null }} [options]
 * @returns {{ hot: object, dir: string }}
 */
export function promptLayersHot(createHot, root, layers, { tmpDir = os.tmpdir(), mergeJson = null } = {}) {
  const sources = layers.map((layer) => {
    const source = path.resolve(root, layer);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new CliError(`replay-cli: ${layer} is not a directory`);
    return source;
  });
  const dir = fs.mkdtempSync(path.join(tmpDir, 'nep-prompt-layers-'));
  try {
    for (const name of ['config.json', 'config.local.json']) {
      if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(dir, name));
    }
    fs.cpSync(path.join(root, 'prompts'), path.join(dir, 'prompts'), { recursive: true });
    const local = path.join(dir, 'prompts.local');
    fs.mkdirSync(local, { recursive: true });
    for (const source of sources) {
      // With mergeJson, a JSON layer file meeting one already laid down is merged over it: the one
      // there is read before the copy and the merge written after it.
      const kept = typeof mergeJson === 'function'
        ? JSON_LAYER_FILES.filter((name) => fs.existsSync(path.join(source, name)) && fs.existsSync(path.join(local, name))).map((name) => [name, readJson(path.join(local, name))])
        : [];
      fs.cpSync(source, local, { recursive: true, force: true });
      for (const [name, base] of kept) {
        const value = mergeJson(base, readJson(path.join(source, name)));
        fs.writeFileSync(path.join(local, name), `${JSON.stringify(value, null, 2)}\n`);
      }
    }
    return { hot: createHot({ rootDir: dir }), dir };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
