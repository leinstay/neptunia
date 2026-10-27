#!/usr/bin/env node
// Moves a deployment's local tool texts to the place the engine now reads them, and renames the one label section that
// goes with them. Run it once per deployment, from the checkout, before the first start of an engine that reads the new
// places:
//
//   node tools/tools-file-move.mjs --dry-run [--dir <private dir>]
//   node tools/tools-file-move.mjs --apply [--dir <private dir>]
//
// The private directory is `--dir`, else `NEPTUNIA_PRIVATE_DIR`, else the checkout (src/paths.js). Two things move:
//
//   1. prompts.local/skills.json (the owner's tool texts) to config.local/tools.json, the entry `skills.describe`
//      renamed `tools.describe` on the way.
//   2. the `skills` section of prompts.local/labels.json (the wording of the tool results) to the key `tools`.
//
// Old file only: it moves. New file only, or neither: nothing to do. Both, with the same content: the old one is
// deleted. Both, with different content: refused, and the keys that differ are listed. A refusal in either half stops
// the whole run before a file changes, so a run is done or refused, never half done. A second run finds nothing to do.
// `--dry-run` says what `--apply` would do and writes nothing.

import fs from 'node:fs';
import path from 'node:path';
import { CliError, parseFlags, privateDirOf, runCli } from './lib/cli.mjs';

const USAGE = 'usage: node tools/tools-file-move.mjs --dry-run|--apply [--dir <private dir>]';
const OLD_TEXTS = path.join('prompts.local', 'skills.json');
const NEW_TEXTS = path.join('config.local', 'tools.json');
const LABELS = path.join('prompts.local', 'labels.json');

/** @typedef {Record<string, unknown>} Obj */
/** @typedef {{ write: string, content: unknown, note: string } | { remove: string, note: string }} Step */

/**
 * @param {unknown} value
 * @returns {value is Obj}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `value` with every object's keys sorted, so equal content compares equal whatever the order of its keys.
 * @param {unknown} value
 * @returns {unknown}
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * The keys of `a` and `b` that are in one only or hold different content.
 * @param {Obj} a
 * @param {Obj} b
 * @returns {string[]}
 */
function differing(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !same(a[key], b[key])).sort();
}

/**
 * The parsed JSON in `file`, or null when it is absent. A file that is not an object is a CliError.
 * @param {string} file
 * @returns {Obj | null}
 */
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError(
      `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); nothing was changed`
    );
  }
  if (!isObject(parsed)) throw new CliError(`${file} must hold a JSON object; nothing was changed`);
  return parsed;
}

/**
 * The tool texts with the entry `skills.describe` under its new name `tools.describe`.
 * @param {Obj} texts
 * @returns {Obj}
 */
function renamedTexts(texts) {
  /** @type {Obj} */
  const out = {};
  for (const [key, value] of Object.entries(texts)) out[key === 'skills.describe' ? 'tools.describe' : key] = value;
  return out;
}

/**
 * What the run would do in the private directory `dir`: `{ steps, refusals }`. A step is `{ write, content, note }` or
 * `{ remove, note }` with paths relative to `dir`; a refusal is a line for the operator.
 * @param {string} dir
 * @returns {{ steps: Step[], refusals: string[] }}
 */
export function planMove(dir) {
  /** @type {Step[]} */
  const steps = [];
  /** @type {string[]} */
  const refusals = [];

  const oldTexts = readJson(path.join(dir, OLD_TEXTS));
  const newTexts = readJson(path.join(dir, NEW_TEXTS));
  if (oldTexts !== null) {
    const moved = renamedTexts(oldTexts);
    if (newTexts === null) {
      steps.push({ write: NEW_TEXTS, content: moved, note: `move ${OLD_TEXTS} to ${NEW_TEXTS}` });
      steps.push({ remove: OLD_TEXTS, note: `remove ${OLD_TEXTS}` });
    } else if (same(moved, newTexts)) {
      steps.push({ remove: OLD_TEXTS, note: `remove ${OLD_TEXTS} (${NEW_TEXTS} holds the same texts)` });
    } else {
      refusals.push(
        `${OLD_TEXTS} and ${NEW_TEXTS} differ in: ${differing(moved, newTexts).join(', ')} (tools.json refused; merge by hand)`
      );
    }
  }

  const labels = readJson(path.join(dir, LABELS));
  if (labels !== null && Object.hasOwn(labels, 'skills')) {
    const { skills, ...rest } = labels;
    if (!Object.hasOwn(labels, 'tools')) {
      steps.push({
        write: LABELS,
        content: { ...rest, tools: skills },
        note: `rename the \`skills\` section of ${LABELS} to \`tools\``,
      });
    } else if (same(skills, labels.tools)) {
      steps.push({
        write: LABELS,
        content: rest,
        note: `drop the \`skills\` section of ${LABELS} (\`tools\` says the same)`,
      });
    } else {
      const a = isObject(skills) ? skills : {};
      const b = isObject(labels.tools) ? labels.tools : {};
      refusals.push(
        `${LABELS} has \`skills\` and \`tools\` sections that differ in: ${differing(a, b).join(', ')} (labels.json refused; merge by hand)`
      );
    }
  }
  return { steps, refusals };
}

/**
 * Writes JSON to `file` through a temporary file, so a crash leaves the old content or the new, not half.
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.moving`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

/**
 * @param {string[]} argv
 * @returns {Promise<string>}
 */
export function main(argv) {
  return Promise.resolve(move(argv));
}

/**
 * @param {string[]} argv
 * @returns {string}
 */
function move(argv) {
  /** @type {Record<string, unknown>} */
  const flags = parseFlags(argv, { values: ['--dir'], switches: ['--dry-run', '--apply'], usage: USAGE });
  if (flags['--dry-run'] === flags['--apply'])
    throw new CliError(`give exactly one of --dry-run and --apply\n${USAGE}`);
  const dir = typeof flags['--dir'] === 'string' ? path.resolve(flags['--dir']) : privateDirOf(process.cwd());
  const { steps, refusals } = planMove(dir);
  if (refusals.length > 0) throw new CliError(`refused, nothing was changed:\n${refusals.join('\n')}`);
  if (steps.length === 0) return 'nothing to move\n';
  if (flags['--dry-run']) return `${steps.map((step) => `would ${step.note}`).join('\n')}\n`;
  for (const step of steps) {
    if ('write' in step) writeJson(path.join(dir, step.write), step.content);
    else fs.rmSync(path.join(dir, step.remove), { force: true });
  }
  return `${steps.map((step) => `${step.note}`).join('\n')}\n`;
}

runCli(import.meta.url, main);
