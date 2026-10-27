#!/usr/bin/env node
// Moves a deployment's local tool texts to the place the engine now reads them, renames the label section that goes with
// them, and renames what the errand and intention names changed in a local layer. Run it once per deployment, from the
// checkout, before the first start of an engine that reads the new places:
//
//   node tools/tools-file-move.mjs --dry-run [--dir <private dir>]
//   node tools/tools-file-move.mjs --apply [--dir <private dir>]
//
// The private directory is `--dir`, else `NEPTUNIA_PRIVATE_DIR`, else the checkout (src/paths.js). Three things move:
//
//   1. prompts.local/skills.json (the owner's tool texts) to config.local/tools.json, the entry `skills.describe`
//      renamed `tools.describe` on the way.
//   2. the `skills` section of prompts.local/labels.json (the wording of the tool results) to the key `tools`.
//   3. the errand and intention names: in config.local/tools.json the ten keys `task.*` and `intent.*` become
//      `errand.*` and `intention.*`, and in prompts.local/labels.json the section `tasks` becomes `errands`, the trigger
//      `task` becomes `errand`, the note `task-missing` becomes `errand-missing`, the three codes `no-task`, `task-ended`
//      and `wait-without-task` under `tools.result.reasons` take their new names, and the placeholder `{task}` becomes
//      `{errand}` in the texts that carry it.
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

/** The tools whose names changed, old to new: a tool texts file keeps its entries under the name of each. */
const TOOL_RENAMES = Object.freeze({
  'skills.describe': 'tools.describe',
  'task.run': 'errand.run',
  'task.status': 'errand.status',
  'task.read': 'errand.read',
  'task.resolve': 'errand.resolve',
  'task.cancel': 'errand.cancel',
  'task.list': 'errand.list',
  'intent.set': 'intention.set',
  'intent.update': 'intention.update',
  'intent.cancel': 'intention.cancel',
  'intent.list': 'intention.list',
});

/** The reason codes of the tool results that changed their names. */
const REASON_RENAMES = Object.freeze({
  'no-task': 'no-errand',
  'task-ended': 'errand-ended',
  'wait-without-task': 'wait-without-errand',
});

/**
 * `object` with the keys of `table` under their new names, each in the place its key had. A key whose new name is also
 * there keeps the new entry when both hold the same content (the old one goes); with different content it is a conflict.
 * @param {Obj} object
 * @param {Record<string, string>} table
 * @returns {{ value: Obj, changed: boolean, conflicts: string[] }}
 */
function renameKeys(object, table) {
  /** @type {Obj} */
  const value = {};
  /** @type {string[]} */
  const conflicts = [];
  let changed = false;
  for (const [key, entry] of Object.entries(object)) {
    const target = table[key];
    if (target === undefined) {
      if (!Object.hasOwn(value, key)) value[key] = entry;
      continue;
    }
    changed = true;
    if (!Object.hasOwn(object, target)) value[target] = entry;
    else if (!same(entry, object[target])) conflicts.push(`${key} and ${target}`);
  }
  return { value, changed, conflicts };
}

/**
 * The tool texts with every tool under its current name.
 * @param {Obj} texts
 * @returns {{ value: Obj, changed: boolean, conflicts: string[] }}
 */
const renamedTexts = (texts) => renameKeys(texts, TOOL_RENAMES);

/**
 * `labels[section][key]`'s object, or an empty one.
 * @param {Obj} labels
 * @param {string[]} path
 * @returns {Obj}
 */
function sectionAt(labels, path) {
  /** @type {unknown} */
  let found = labels;
  for (const name of path) found = isObject(found) ? found[name] : undefined;
  return isObject(found) ? found : {};
}

/**
 * `labels` with the errand and intention names of a local labels file: the section `tasks` as `errands`, the trigger `task`
 * as `errand`, the note `task-missing` as `errand-missing`, the reason codes of `tools.result.reasons`, and the placeholder
 * `{task}` as `{errand}` in the texts that carry it. A section both names hold with different content is a conflict.
 * @param {Obj} labels
 * @returns {{ value: Obj, changed: boolean, conflicts: string[] }}
 */
function renamedLabels(labels) {
  const top = renameKeys(labels, { tasks: 'errands' });
  /** @type {Obj} */
  let value = top.value;
  let changed = top.changed;
  const conflicts = top.conflicts.map((pair) => `${pair} (a section)`);
  /** @param {string[]} path @param {Record<string, string>} table */
  const within = (path, table) => {
    const holder = sectionAt(value, path);
    if (Object.keys(holder).length === 0) return;
    const renamed = renameKeys(holder, table);
    conflicts.push(...renamed.conflicts.map((pair) => `${path.join('.')}: ${pair}`));
    if (!renamed.changed) return;
    changed = true;
    value = setAt(value, path, renamed.value);
  };
  within(['triggers'], { task: 'errand' });
  within(['intentions', 'notes'], { 'task-missing': 'errand-missing' });
  within(['tools', 'result', 'reasons'], REASON_RENAMES);
  for (const path of [
    ['intentions', 'waiting'],
    ['intentions', 'outcome'],
    ['wake', 'kinds', 'errand_deadline'],
  ]) {
    const text = textAt(value, path);
    if (text !== null && text.includes('{task}')) {
      changed = true;
      value = setAt(value, path, text.replaceAll('{task}', '{errand}'));
    }
  }
  const notes = sectionAt(value, ['intentions', 'notes']);
  for (const [key, text] of Object.entries(notes)) {
    if (typeof text === 'string' && text.includes('{task}')) {
      changed = true;
      value = setAt(value, ['intentions', 'notes', key], text.replaceAll('{task}', '{errand}'));
    }
  }
  return { value, changed, conflicts };
}

/**
 * The string at `path` of `object`, or null.
 * @param {Obj} object
 * @param {string[]} path
 * @returns {string | null}
 */
function textAt(object, path) {
  /** @type {unknown} */
  let found = object;
  for (const name of path) found = isObject(found) ? found[name] : undefined;
  return typeof found === 'string' ? found : null;
}

/**
 * A copy of `object` with `value` at `path`, every other key as it was and in its place.
 * @param {Obj} object
 * @param {string[]} path
 * @param {unknown} value
 * @returns {Obj}
 */
function setAt(object, path, value) {
  const [head, ...rest] = path;
  if (head === undefined) return object;
  const inner = rest.length === 0 ? value : setAt(isObject(object[head]) ? object[head] : {}, rest, value);
  return { ...object, [head]: inner };
}

/**
 * The steps and refusals for the tool texts of the private directory `dir`: the old file moved, the keys of the new one
 * renamed.
 * @param {string} dir
 * @returns {{ steps: Step[], refusals: string[] }}
 */
function planTexts(dir) {
  /** @type {Step[]} */
  const steps = [];
  /** @type {string[]} */
  const refusals = [];
  const oldTexts = readJson(path.join(dir, OLD_TEXTS));
  const newTexts = readJson(path.join(dir, NEW_TEXTS));
  const moved = oldTexts === null ? null : renamedTexts(oldTexts);
  const settled = newTexts === null ? null : renamedTexts(newTexts);
  for (const pair of moved?.conflicts ?? [])
    refusals.push(`${OLD_TEXTS} holds ${pair} with different texts (merge by hand)`);
  for (const pair of settled?.conflicts ?? [])
    refusals.push(`${NEW_TEXTS} holds ${pair} with different texts (merge by hand)`);
  if (refusals.length > 0) return { steps, refusals };
  const rename = { write: NEW_TEXTS, content: settled?.value, note: `rename the tool keys of ${NEW_TEXTS}` };
  if (moved === null) {
    if (settled?.changed) steps.push(rename);
  } else if (settled === null) {
    steps.push({ write: NEW_TEXTS, content: moved.value, note: `move ${OLD_TEXTS} to ${NEW_TEXTS}` });
    steps.push({ remove: OLD_TEXTS, note: `remove ${OLD_TEXTS}` });
  } else if (same(moved.value, settled.value)) {
    if (settled.changed) steps.push(rename);
    steps.push({ remove: OLD_TEXTS, note: `remove ${OLD_TEXTS} (${NEW_TEXTS} holds the same texts)` });
  } else {
    refusals.push(
      `${OLD_TEXTS} and ${NEW_TEXTS} differ in: ${differing(moved.value, settled.value).join(', ')} (tools.json refused; merge by hand)`
    );
  }
  return { steps, refusals };
}

/**
 * The labels with the `skills` section as `tools`, or a refusal when both sections are there with different content.
 * @param {Obj} labels
 * @returns {{ content: Obj, notes: string[], refusals: string[] }}
 */
function skillsSection(labels) {
  if (!Object.hasOwn(labels, 'skills')) return { content: labels, notes: [], refusals: [] };
  const { skills, ...rest } = labels;
  if (!Object.hasOwn(labels, 'tools'))
    return {
      content: { ...rest, tools: skills },
      notes: [`rename the \`skills\` section of ${LABELS} to \`tools\``],
      refusals: [],
    };
  if (same(skills, labels.tools))
    return {
      content: rest,
      notes: [`drop the \`skills\` section of ${LABELS} (\`tools\` says the same)`],
      refusals: [],
    };
  const a = isObject(skills) ? skills : {};
  const b = isObject(labels.tools) ? labels.tools : {};
  return {
    content: labels,
    notes: [],
    refusals: [
      `${LABELS} has \`skills\` and \`tools\` sections that differ in: ${differing(a, b).join(', ')} (labels.json refused; merge by hand)`,
    ],
  };
}

/**
 * The steps and refusals for the labels file of the private directory `dir`: the `skills` section moved, the errand and
 * intention names renamed, in one write.
 * @param {string} dir
 * @returns {{ steps: Step[], refusals: string[] }}
 */
function planLabels(dir) {
  const labels = readJson(path.join(dir, LABELS));
  if (labels === null) return { steps: [], refusals: [] };
  const section = skillsSection(labels);
  const errands = renamedLabels(section.content);
  const refusals = [
    ...section.refusals,
    ...errands.conflicts.map(
      (pair) => `${LABELS} holds ${pair} with different content (labels.json refused; merge by hand)`
    ),
  ];
  if (refusals.length > 0) return { steps: [], refusals };
  const notes = errands.changed
    ? [...section.notes, `rename the errand and intention names in ${LABELS}`]
    : section.notes;
  if (notes.length === 0) return { steps: [], refusals };
  return { steps: [{ write: LABELS, content: errands.value, note: notes.join('; ') }], refusals };
}

/**
 * What the run would do in the private directory `dir`: `{ steps, refusals }`. A step is `{ write, content, note }` or
 * `{ remove, note }` with paths relative to `dir`; a refusal is a line for the operator.
 * @param {string} dir
 * @returns {{ steps: Step[], refusals: string[] }}
 */
export function planMove(dir) {
  const texts = planTexts(dir);
  const labels = planLabels(dir);
  return { steps: [...texts.steps, ...labels.steps], refusals: [...texts.refusals, ...labels.refusals] };
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
