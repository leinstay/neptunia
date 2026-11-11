// The setup contract of an optional module, an interface or an executable skill: the module declares its settings in
// `setup.json`, and this file validates that declaration and stores the values. `neptunia setup`, `/interfaces setup`,
// `/skills setup` and the targeted set, clear, add and remove commands all write through here, so a value set either
// way lands in the same place. A module owns `data/interfaces/<name>/` or `data/skills/<name>/`: plain values go to its
// `config.json`, secrets to its `credentials.json` at mode 0600. A value is read back masked when it is a secret.
// Deleting a module's code or disabling it touches none of this. Called by src/setup/run.ts and
// src/interface/commands/module-setup.ts.

import fs from 'node:fs';
import path from 'node:path';
import { interfacePackageDir } from '../config/files.ts';

export const MODULE_KINDS = ['interface', 'skill'] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];
export type ModuleRef = { rootDir: string; dataDir: string; kind: ModuleKind; name: string };

const SETTING_KINDS = ['text', 'list', 'secret'] as const;
type SettingKind = (typeof SETTING_KINDS)[number];
/** `roots`: the list setting that holds the roots the interface serves, which the core writes on an accept or a remove. */
export type ModuleSetting = { key: string; question: string; kind: SettingKind; required: boolean; roots: boolean };
export type ModuleValue = { key: string; kind: SettingKind; required: boolean; value: string | null };
type Json = Record<string, unknown>;

/** A module name: lowercase letters, digits, dashes and underscores, so it cannot leave its folder. */
const MODULE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const SETTING_KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSetting(raw: unknown, source: string): ModuleSetting {
  if (!isJson(raw) || typeof raw.key !== 'string' || !SETTING_KEY.test(raw.key))
    throw new Error(`${source}: a setting needs a key of letters, digits and underscores`);
  const kind = SETTING_KINDS.find((one) => one === raw.kind);
  if (kind === undefined) throw new Error(`${source}: ${raw.key} needs a kind, one of ${SETTING_KINDS.join(', ')}`);
  if (typeof raw.question !== 'string' || raw.question.trim() === '')
    throw new Error(`${source}: ${raw.key} needs a question`);
  const roots = raw.roots === true;
  if (roots && kind !== 'list') throw new Error(`${source}: ${raw.key} holds the roots, so it must be a list`);
  return { key: raw.key, question: raw.question, kind, required: raw.required === true, roots };
}

/** Where the module keeps its values. */
export function moduleDir({ dataDir, kind, name }: ModuleRef): string {
  if (!MODULE_NAME.test(name)) throw new Error(`invalid module name "${name}"; use lowercase letters, digits, - and _`);
  return path.join(dataDir, kind === 'interface' ? 'interfaces' : 'skills', name);
}

/** The declared settings of a module, or null when its code declares none or is gone. A broken declaration throws. */
export function readModuleSettings(ref: ModuleRef): Array<ModuleSetting> | null {
  const dir = moduleDir(ref);
  const code = ref.kind === 'interface' ? interfacePackageDir(ref.rootDir, ref.dataDir, ref.name) : dir;
  const file = path.join(code, 'setup.json');
  if (!fs.existsSync(file)) return null;
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isJson(parsed) || !Array.isArray(parsed.settings))
    throw new Error(`${file}: the contract is an object with a settings list`);
  const settings = parsed.settings.map((raw) => parseSetting(raw, file));
  if (new Set(settings.map((one) => one.key)).size !== settings.length)
    throw new Error(`${file}: a setting key appears twice`);
  if (settings.filter((one) => one.roots).length > 1) throw new Error(`${file}: only one setting may hold the roots`);
  return settings;
}

function readJson(file: string): Json {
  if (!fs.existsSync(file)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isJson(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

/** Writes through a temp file at `mode`, so a reader never sees half a file and a secret is never readable by others. */
function writeJson(file: string, value: Json, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

function fileOf(ref: ModuleRef, setting: ModuleSetting): { file: string; mode: number } {
  return setting.kind === 'secret'
    ? { file: path.join(moduleDir(ref), 'credentials.json'), mode: 0o600 }
    : { file: path.join(moduleDir(ref), 'config.json'), mode: 0o640 };
}

function settingOf(settings: ReadonlyArray<ModuleSetting>, key: string): ModuleSetting {
  const setting = settings.find((one) => one.key === key);
  if (setting === undefined)
    throw new Error(`no setting "${key}"; this module has ${settings.map((one) => one.key).join(', ') || 'none'}`);
  return setting;
}

/** A stored scalar as text; a value of another shape is its JSON, so nothing prints as `[object Object]`. */
function textOf(stored: unknown): string {
  return typeof stored === 'string' ? stored : JSON.stringify(stored);
}

function shown(setting: ModuleSetting, stored: unknown): string | null {
  if (stored === undefined || stored === '' || (Array.isArray(stored) && stored.length === 0)) return null;
  if (setting.kind === 'secret') return `set, ends in ${textOf(stored).slice(-4)}`;
  return Array.isArray(stored) ? stored.map(textOf).join(' ') : textOf(stored);
}

/** Every declared setting with its stored value; a secret shows only that it is set and its last four characters. */
export function moduleValues(ref: ModuleRef, settings: ReadonlyArray<ModuleSetting>): Array<ModuleValue> {
  return settings.map((setting) => ({
    key: setting.key,
    kind: setting.kind,
    required: setting.required,
    value: shown(setting, readJson(fileOf(ref, setting).file)[setting.key]),
  }));
}

function words(text: string): Array<string> {
  return text.split(/[\s,]+/).filter((word) => word !== '');
}

/** Stores `answer`, replacing the value. A list takes words; a secret or a word list holds no blank. */
export function setModuleValue(
  ref: ModuleRef,
  settings: ReadonlyArray<ModuleSetting>,
  key: string,
  answer: string
): void {
  const setting = settingOf(settings, key);
  const text = answer.trim();
  if (text === '') throw new Error(`${key} needs a value; clear it with the clear command`);
  if (setting.kind === 'secret' && /\s/.test(text)) throw new Error(`${key} holds no whitespace; nothing is written`);
  const { file, mode } = fileOf(ref, setting);
  const value = setting.kind === 'list' ? [...new Set(words(text))] : text;
  writeJson(file, { ...readJson(file), [key]: value }, mode);
}

/** Removes the value; the other values of the file stay. */
export function clearModuleValue(ref: ModuleRef, settings: ReadonlyArray<ModuleSetting>, key: string): void {
  const setting = settingOf(settings, key);
  const { file, mode } = fileOf(ref, setting);
  writeJson(file, Object.fromEntries(Object.entries(readJson(file)).filter(([name]) => name !== key)), mode);
}

function listOf(ref: ModuleRef, settings: ReadonlyArray<ModuleSetting>, key: string) {
  const setting = settingOf(settings, key);
  if (setting.kind !== 'list') throw new Error(`${key} is not a list; use the set command`);
  const { file, mode } = fileOf(ref, setting);
  const stored = readJson(file)[key];
  return { file, mode, items: Array.isArray(stored) ? stored.map(textOf) : [] };
}

/** Adds one item of a list setting, so the rest need not be typed again. An item already there stays once. */
export function addModuleItem(ref: ModuleRef, settings: ReadonlyArray<ModuleSetting>, key: string, item: string): void {
  const { file, mode, items } = listOf(ref, settings, key);
  writeJson(file, { ...readJson(file), [key]: [...new Set([...items, ...words(item)])] }, mode);
}

/** Removes one item of a list setting; false when the item was not there. */
export function removeModuleItem(
  ref: ModuleRef,
  settings: ReadonlyArray<ModuleSetting>,
  key: string,
  item: string
): boolean {
  const { file, mode, items } = listOf(ref, settings, key);
  if (!items.includes(item.trim())) return false;
  writeJson(file, { ...readJson(file), [key]: items.filter((one) => one !== item.trim()) }, mode);
  return true;
}

/** The items stored in a list setting, as text. */
export function moduleItems(ref: ModuleRef, settings: ReadonlyArray<ModuleSetting>, key: string): Array<string> {
  return listOf(ref, settings, key).items;
}

/** One question to the owner; an empty answer keeps what is stored. */
export type ModuleAsk = (setting: ModuleSetting, current: string | null) => Promise<string>;

/** Asks every declared setting in order and stores the answers, through the same writers as the targeted commands. */
export async function walkModuleSetup(
  ref: ModuleRef,
  settings: ReadonlyArray<ModuleSetting>,
  ask: ModuleAsk
): Promise<{ missing: Array<string> }> {
  const missing: Array<string> = [];
  for (const row of moduleValues(ref, settings)) {
    const setting = settingOf(settings, row.key);
    const answer = (await ask(setting, row.value)).trim();
    if (answer !== '') setModuleValue(ref, settings, row.key, answer);
    else if (row.value === null && row.required) missing.push(row.key);
  }
  return { missing };
}
