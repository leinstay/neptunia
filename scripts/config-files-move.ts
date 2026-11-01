#!/usr/bin/env node
// Moves a deployment's private settings and labels to the places the engine reads them (src/config/files.ts). Run it
// once per deployment, from the checkout:
//
//   node scripts/config-files-move.ts --private <dir>           says what it would do and writes nothing
//   node scripts/config-files-move.ts --private <dir> --apply   does it
//
// Two files move. `config.local.json` goes to `config.local/config.json` byte for byte. The flat
// `prompts.local/labels.json` goes to `config.local/labels.json`, split into `model` and `owner` by the checkout's
// `config/labels.json` (src/config/labels.ts#splitLabels): a key the tracked file holds under `owner` goes there, any
// other key under `model`.
//
// Old file only: it moves. New file only, or neither: nothing to do. Both, with the same content (the labels compared
// after the split): the old one is deleted. Both, with different content: refused, naming the old file. A refusal stops
// the whole run before a file changes, so a run is done or refused, never half done. A second run finds nothing to do.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, parseFlags, runCli } from './lib/cli.ts';
import { CONFIG_DIR, LABELS_FILE, LOCAL_CONFIG_DIR, OLD_LOCAL_CONFIG, OLD_LOCAL_LABELS } from '../src/config/files.ts';
import { splitLabels } from '../src/config/labels.ts';

const USAGE = 'usage: node scripts/config-files-move.ts --private <dir> [--apply]';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEW_CONFIG = path.join(LOCAL_CONFIG_DIR, 'config.json');
const NEW_LABELS = path.join(LOCAL_CONFIG_DIR, LABELS_FILE);

type Obj = Record<string, unknown>;
type Step =
  | { rename: string; to: string; note: string }
  | { write: string; content: unknown; note: string }
  | { remove: string; note: string };

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value` with every object's keys sorted, so equal content compares equal whatever the order of its keys. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** The JSON object in `file`, `{}` when it is blank, null when it is absent. Anything else is a CliError. */
function readJson(file: string): Obj | null {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(
      `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); nothing was changed`
    );
  }
  if (!isObject(parsed)) throw new CliError(`${file} must hold a JSON object; nothing was changed`);
  return parsed;
}

/** The tracked labels of the checkout as `{ model, owner }`. */
function trackedLabels(): { model: Obj; owner: Obj } {
  const file = readJson(path.join(ROOT, CONFIG_DIR, LABELS_FILE)) ?? {};
  return { model: isObject(file.model) ? file.model : {}, owner: isObject(file.owner) ? file.owner : {} };
}

/** What the run would do in the private directory `dir`: `{ steps, refusals }`, paths relative to `dir`. */
function planMove(dir: string): { steps: Array<Step>; refusals: Array<string> } {
  const steps: Array<Step> = [];
  const refusals: Array<string> = [];
  const oldConfig = readJson(path.join(dir, OLD_LOCAL_CONFIG));
  const newConfig = readJson(path.join(dir, NEW_CONFIG));
  if (oldConfig !== null && newConfig === null)
    steps.push({ rename: OLD_LOCAL_CONFIG, to: NEW_CONFIG, note: `move ${OLD_LOCAL_CONFIG} to ${NEW_CONFIG}` });
  else if (oldConfig !== null && same(oldConfig, newConfig))
    steps.push({ remove: OLD_LOCAL_CONFIG, note: `remove ${OLD_LOCAL_CONFIG}, which ${NEW_CONFIG} already holds` });
  else if (oldConfig !== null)
    refusals.push(`${OLD_LOCAL_CONFIG} and ${NEW_CONFIG} hold different settings (merge by hand)`);

  const oldLabels = readJson(path.join(dir, OLD_LOCAL_LABELS));
  const newLabels = readJson(path.join(dir, NEW_LABELS));
  const split = oldLabels === null ? null : splitLabels(oldLabels, trackedLabels());
  const settled =
    newLabels === null
      ? null
      : {
          model: isObject(newLabels.model) ? newLabels.model : {},
          owner: isObject(newLabels.owner) ? newLabels.owner : {},
        };
  if (split !== null && settled === null) {
    steps.push({ write: NEW_LABELS, content: split, note: `move ${OLD_LOCAL_LABELS} to ${NEW_LABELS}, split` });
    steps.push({ remove: OLD_LOCAL_LABELS, note: `remove ${OLD_LOCAL_LABELS}` });
  } else if (split !== null && same(split, settled))
    steps.push({ remove: OLD_LOCAL_LABELS, note: `remove ${OLD_LOCAL_LABELS}, which ${NEW_LABELS} already holds` });
  else if (split !== null) refusals.push(`${OLD_LOCAL_LABELS} and ${NEW_LABELS} hold different labels (merge by hand)`);
  return { steps, refusals };
}

/** Writes JSON to `file` through a temporary file, so a crash leaves the old content or the new, not half. */
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.moving`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export function main(argv: Array<string>): Promise<string> {
  return Promise.resolve(move(argv));
}

function move(argv: Array<string>): string {
  const flags: Record<string, unknown> = parseFlags(argv, {
    values: ['--private'],
    switches: ['--apply'],
    usage: USAGE,
  });
  if (typeof flags['--private'] !== 'string') throw new CliError(`name the private directory with --private\n${USAGE}`);
  const dir = path.resolve(flags['--private']);
  const { steps, refusals } = planMove(dir);
  if (refusals.length > 0) throw new CliError(`refused, nothing was changed:\n${refusals.join('\n')}`);
  if (steps.length === 0) return 'nothing to move\n';
  if (flags['--apply'] !== true) return `${steps.map((step) => `would ${step.note}`).join('\n')}\n`;
  for (const step of steps) {
    if ('rename' in step) {
      fs.mkdirSync(path.dirname(path.join(dir, step.to)), { recursive: true });
      fs.renameSync(path.join(dir, step.rename), path.join(dir, step.to));
    } else if ('write' in step) writeJson(path.join(dir, step.write), step.content);
    else fs.rmSync(path.join(dir, step.remove), { force: true });
  }
  return `${steps.map((step) => step.note).join('\n')}\n`;
}

runCli(import.meta.url, main);
