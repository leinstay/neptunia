// The one way a tool lays extra prompt directories over the bot's prompts for a run
// (tools/replay.mjs --pair and --diary): a scratch root holding a copy of the bot's config
// files and its tracked prompts/, with the given directories copied into prompts.local/ in
// order, read by src/hot.js exactly as the bot reads its own layers. Nothing in the checkout
// changes; the caller closes the hot view and removes the scratch root.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './cli.mjs';

/**
 * A hot view (src/hot.js#createHot) over a scratch root: `root`'s config.json and
 * config.local.json, its prompts/, and every directory of `layers` (resolved against `root`)
 * copied into prompts.local/ one after another, so a later layer's file replaces an earlier
 * one of the same name whole (labels.json included: replaced, not merged). A layer that is
 * not a directory is a CliError.
 * @param {(options: { rootDir: string }) => object} createHot
 * @param {string} root  The bot's checkout.
 * @param {string[]} layers
 * @param {{ tmpDir?: string }} [options]
 * @returns {{ hot: object, dir: string }}
 */
export function promptLayersHot(createHot, root, layers, { tmpDir = os.tmpdir() } = {}) {
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
    fs.mkdirSync(path.join(dir, 'prompts.local'), { recursive: true });
    for (const source of sources) fs.cpSync(source, path.join(dir, 'prompts.local'), { recursive: true, force: true });
    return { hot: createHot({ rootDir: dir }), dir };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
