// The owner's commands over the setup contract of a module (src/setup/modules.ts): `setup`, `settings`, `set`, `clear`,
// `add` and `remove` of `/interface` and `/skills`. Answers name keys and masked values, never a secret. A secret is
// asked in the chat's secret dialog and never travels as an argument. Called by src/interface/commands/console.ts.

import {
  addModuleItem,
  clearModuleValue,
  moduleValues,
  readModuleSettings,
  removeModuleItem,
  setModuleValue,
  walkModuleSetup,
} from '../../setup/modules.ts';
import type { ModuleKind, ModuleRef, ModuleSetting } from '../../setup/modules.ts';
import type { Dialog } from '../../keys/commands.ts';

export type ModuleAnswer = { text: string; status: string };
export const MODULE_ACTIONS = ['setup', 'settings', 'set', 'clear', 'add', 'remove'] as const;
export type ModuleAction = (typeof MODULE_ACTIONS)[number];

const secretOf = (settings: ReadonlyArray<ModuleSetting>, key: string): boolean =>
  settings.find((one) => one.key === key)?.kind === 'secret';

function settingsText(ref: ModuleRef, settings: ReadonlyArray<ModuleSetting>): string {
  if (settings.length === 0) return `${ref.name} has no settings`;
  return moduleValues(ref, settings)
    .map((row) => `${row.key}: ${row.value ?? (row.required ? 'not set (required)' : 'not set')}`)
    .join('\n');
}

async function act(
  ref: ModuleRef,
  settings: ReadonlyArray<ModuleSetting>,
  action: ModuleAction,
  args: { key: string; value: string },
  dialog: Dialog | null
): Promise<string> {
  const { key, value } = args;
  switch (action) {
    case 'settings':
      return settingsText(ref, settings);
    case 'setup': {
      if (dialog === null) throw new Error('setup asks in the chat; run the command there');
      const { missing } = await walkModuleSetup(ref, settings, (setting, current) =>
        dialog.ask(
          current === null ? `${setting.question}:` : `${setting.question} (now ${current}, empty keeps it):`,
          {
            secret: setting.kind === 'secret',
          }
        )
      );
      const end = missing.length === 0 ? '' : `\nstill required: ${missing.join(', ')}`;
      return `${settingsText(ref, settings)}${end}`;
    }
    case 'set': {
      if (!secretOf(settings, key)) {
        setModuleValue(ref, settings, key, value);
        return `${key} set`;
      }
      if (value !== '') throw new Error(`${key} is a secret; give no value on the line, the chat asks for it`);
      if (dialog === null) throw new Error(`${key} is asked in the chat; run the command there`);
      setModuleValue(ref, settings, key, await dialog.ask(`${key} of ${ref.name}:`, { secret: true }));
      return `${key} set`;
    }
    case 'clear':
      clearModuleValue(ref, settings, key);
      return `${key} cleared`;
    case 'add':
      addModuleItem(ref, settings, key, value);
      return `${value} added to ${key}`;
    case 'remove':
      return removeModuleItem(ref, settings, key, value) ? `${value} removed from ${key}` : `${value} is not in ${key}`;
  }
}

/** Runs one action on a module and answers in text; a refused or failed action names why and changes nothing. */
export async function moduleCommand(
  where: { rootDir: string; dataDir: string; kind: ModuleKind },
  action: ModuleAction,
  args: Readonly<Record<string, unknown>>,
  dialog: Dialog | null
): Promise<ModuleAnswer> {
  const text = (name: string): string => (typeof args[name] === 'string' ? args[name] : '');
  const ref = { ...where, name: text('name') };
  try {
    const settings = readModuleSettings(ref);
    if (settings === null) return { text: `${ref.name} declares no setup.json`, status: 'invalid' };
    return { text: await act(ref, settings, action, { key: text('key'), value: text('value') }, dialog), status: 'ok' };
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), status: 'invalid' };
  }
}
