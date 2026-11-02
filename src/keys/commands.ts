// The owner's key commands of the chat: `keys core|extra add|remove|list`, `keys bind|unbind|check` and `model set`.
// The console (src/interface/commands/console.ts) routes them here. A key value is never an argument: every add asks
// for it through the dialog the link gives (a secret prompt, src/interface/commands/dialogs.ts), so the value reaches
// neither the typed line, the chat's history file nor a refusal. A key is checked before it is saved (the first core
// key with the four mandatory model roles, a later one with `/auth/key`), and a failed check saves nothing. An answer
// names keys by name and last four characters and never holds a value; a refusal names the store's code, never the word
// that was refused.

import { roleGroup } from '../llm/roles.ts';
import { log } from '../log.ts';
import { checkKey, checkRole } from './check.ts';
import type { CheckResult } from './check.ts';
import type { KeyRing } from './ring.ts';
import { isKeyName, KeysError } from './store.ts';
import type { KeyStore } from './store.ts';

/** The model roles a core key must serve before the first add finishes, in the order they are asked. */
export const MANDATORY_ROLES: ReadonlyArray<string> = ['core', 'memory', 'analyzer', 'embedding'];

/** The pause reason that `keys core remove` of the last key sets and the next `keys core add` lifts. */
const NO_CORE_KEY = 'no-core-key';

/** The model roles whose model OpenCode runs: they are not OpenRouter ids, so no request checks them. */
const UNCHECKED_ROLES: ReadonlyArray<string> = ['scout', 'server', 'thinker', 'dev'];

/** What the chat can ask in the middle of a command. */
export type Dialog = {
  ask(
    question: string,
    options?: { secret?: boolean; fallback?: string; choices?: ReadonlyArray<string> }
  ): Promise<string>;
};

/** The core's pause with a reason. `reason()` is null while she runs. */
export type PauseControl = {
  pause(reason: string): Promise<void>;
  resume(): Promise<void>;
  reason(): string | null;
};

/** One command's answer: the status is `ok`, `invalid` (the line or a name is refused) or `failed` (a check or a save did not go through). */
export type Answer = { text: string; status: string };

export type KeysDeps = {
  store: KeyStore;
  ring: KeyRing;
  fetch: typeof fetch;
  baseUrl(): string;
  /** The tracked model of each mandatory role, offered by the first add. */
  defaults: Readonly<Record<string, string>>;
  /** The live model of a role. */
  currentModel(role: string): string;
  /** Saves a role's model (the console runs the `model.set` operation). */
  saveModel(role: string, model: string): Promise<void>;
  pause: PauseControl;
};

const money = (value: number): string => `$${value.toFixed(4)}`;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The command as the owner typed it, without its arguments: a name or a word of the line may be a pasted key. */
const typed = (name: string): string => `/${name.replaceAll('.', ' ')}`;

const invalid = (name: string, why: string): Answer => ({ text: `${typed(name)}: ${why}`, status: 'invalid' });
const failed = (name: string, why: string): Answer => ({ text: `${typed(name)}: ${why}`, status: 'failed' });

/** A value read from the dialog: a paste often carries a trailing newline or space. */
const pasted = (answer: string): string => answer.trim();

/** Why a pasted value is no key, or null when it can be one. */
const valueProblem = (value: string): string | null =>
  value === '' || /\s/.test(value) ? 'the value is blank or holds a space' : null;

/** How the chat names a check's outcome: the model, the key, whether the provider billed the key as BYOK, the cost. */
function checkLine(result: CheckResult): string {
  const byok = result.isByok === null ? 'is_byok not reported' : `is_byok ${String(result.isByok)}`;
  const head = `${result.role} on ${result.model} with key ${result.keyName}`;
  return result.ok
    ? `${head}: answered, ${byok}, ${money(result.cost)}`
    : `${head}: failed${result.status === null ? '' : ` (HTTP ${result.status})`}: ${result.error ?? 'no reason given'}`;
}

export function createKeysCommands(deps: KeysDeps): {
  run(name: string, args: Record<string, unknown>, dialog: Dialog | null): Promise<Answer>;
} {
  const { store, ring } = deps;

  /** Lifts the pause the last removal set, and only that one. */
  async function resumeIfNoKey(): Promise<boolean> {
    if (deps.pause.reason() !== NO_CORE_KEY) return false;
    await deps.pause.resume();
    return true;
  }

  /** Name and dialog are fine before anything is asked: a bad or used name never reaches the value prompt. */
  function beforeAsking(name: string, key: string, dialog: Dialog | null): Answer | null {
    if (!isKeyName(key)) return invalid(name, new KeysError('bad-name').message);
    if (dialog === null) return invalid(name, 'the key value is asked in the chat: run this command there');
    const listing = store.list();
    if ([...listing.core, ...listing.extra].some((row) => row.name === key))
      return invalid(name, new KeysError('duplicate-name').message);
    return null;
  }

  async function askValue(dialog: Dialog, key: string): Promise<string> {
    return pasted(await dialog.ask(`Paste the key ${key}. Nothing is shown while you type.`, { secret: true }));
  }

  /** The first core key: the value, the four models, one request per model on the new key, and only then the save. */
  async function firstCoreKey(name: string, key: string, value: string, dialog: Dialog): Promise<Answer> {
    const models = new Map<string, string>();
    for (const role of MANDATORY_ROLES) {
      const fallback = deps.defaults[role] ?? '';
      const offered = fallback === '' ? '' : ` (blank takes ${fallback})`;
      const given = pasted(await dialog.ask(`Model for the ${role} role${offered}:`, { fallback }));
      const model = given === '' ? fallback : given;
      if (model === '' || /\s/.test(model)) return invalid(name, `no usable model for the ${role} role`);
      models.set(role, model);
    }
    const results = await Promise.all(
      [...models].map(([role, model]) =>
        checkRole({ fetch: deps.fetch, baseUrl: deps.baseUrl(), role, model, keyName: key, value })
      )
    );
    const bad = results.filter((result) => !result.ok);
    if (bad.length > 0)
      return failed(name, ['nothing is saved, no key and no model.', ...bad.map(checkLine)].join('\n'));
    store.addCore({ name: key, value });
    for (const [role, model] of models) await deps.saveModel(role, model);
    const resumed = await resumeIfNoKey();
    const cost = results.reduce((sum, result) => sum + result.cost, 0);
    return {
      text: [
        `${key} is the first core key. The models are saved:`,
        ...results.map(checkLine),
        `The four checks cost ${money(cost)}.${resumed ? ' She is running again.' : ''}`,
      ].join('\n'),
      status: 'ok',
    };
  }

  async function addCore(name: string, args: Record<string, unknown>, dialog: Dialog | null): Promise<Answer> {
    const key = text(args.name);
    const refused = beforeAsking(name, key, dialog);
    if (refused !== null || dialog === null) return refused ?? invalid(name, 'no dialog');
    const value = await askValue(dialog, key);
    const problem = valueProblem(value);
    if (problem !== null) return invalid(name, problem);
    if (store.coreNames().length === 0) return firstCoreKey(name, key, value, dialog);
    const info = await checkKey({ fetch: deps.fetch, baseUrl: deps.baseUrl(), value });
    if (!info.ok)
      return failed(
        name,
        `the provider refused the key${info.status === null ? '' : ` (HTTP ${info.status})`}: ${info.error ?? 'no reason given'}`
      );
    store.addCore({ name: key, value });
    const resumed = await resumeIfNoKey();
    return { text: `${key} is added to the core keys.${resumed ? ' She is running again.' : ''}`, status: 'ok' };
  }

  async function removeCore(name: string, args: Record<string, unknown>): Promise<Answer> {
    const { left } = store.removeCore(text(args.name));
    if (left > 0) return { text: `The core key is removed. ${left} left.`, status: 'ok' };
    await deps.pause.pause(NO_CORE_KEY);
    return {
      text: 'The last core key is removed. She is paused (no-core-key) until you add a core key.',
      status: 'ok',
    };
  }

  function listCore(): Answer {
    const rows = store.list().core;
    if (rows.length === 0) return { text: 'No core key. Add one with /keys core add <name>.', status: 'ok' };
    const on = ring.route('core')?.name ?? null;
    const lines = rows.map((row) => {
      const grant = row.grant === null ? 'no grant' : `grant $${row.grant}, resets on day ${String(row.resetDay)}`;
      return `${row.name}  ...${row.last4}  ${grant}${row.name === on ? '  (in use)' : ''}`;
    });
    return { text: lines.join('\n'), status: 'ok' };
  }

  async function addExtra(name: string, args: Record<string, unknown>, dialog: Dialog | null): Promise<Answer> {
    const key = text(args.name);
    const refused = beforeAsking(name, key, dialog);
    if (refused !== null || dialog === null) return refused ?? invalid(name, 'no dialog');
    const value = await askValue(dialog, key);
    const problem = valueProblem(value);
    if (problem !== null) return invalid(name, problem);
    const info = await checkKey({ fetch: deps.fetch, baseUrl: deps.baseUrl(), value });
    if (!info.ok)
      return failed(
        name,
        `the provider refused the key${info.status === null ? '' : ` (HTTP ${info.status})`}: ${info.error ?? 'no reason given'}`
      );
    store.addExtra({ name: key, value });
    return {
      text: `${key} is added to the extra keys. Bind a role to it with /keys bind <role> ${key}.`,
      status: 'ok',
    };
  }

  function listExtra(): Answer {
    const rows = store.list().extra;
    if (rows.length === 0) return { text: 'No extra key.', status: 'ok' };
    const lines = rows.map(
      (row) =>
        `${row.name}  ...${row.last4}  ${row.roles.length === 0 ? 'bound to no role' : `bound to ${row.roles.join(', ')}`}`
    );
    return { text: lines.join('\n'), status: 'ok' };
  }

  async function checkOne(name: string, role: string): Promise<Answer> {
    const route = ring.route(role);
    if (route === null)
      return failed(name, `the ${role} role has no key: add a core key or bind the role to an extra key`);
    const result = await checkRole({
      fetch: deps.fetch,
      baseUrl: deps.baseUrl(),
      role,
      model: deps.currentModel(role),
      keyName: route.name,
      value: route.value,
    });
    return { text: checkLine(result), status: result.ok ? 'ok' : 'failed' };
  }

  async function setModel(name: string, args: Record<string, unknown>): Promise<Answer> {
    const role = text(args.role);
    const model = text(args.model);
    const group = roleGroup(role);
    if (group === undefined || model === '') return invalid(name, 'a role and a model are needed');
    if (group !== 'base' || UNCHECKED_ROLES.includes(role)) {
      await deps.saveModel(role, model);
      return { text: `The ${role} model is ${model}. Its id is not checked here.`, status: 'ok' };
    }
    const route = ring.route(role);
    if (route === null)
      return failed(name, `the ${role} role has no key: add a core key or bind the role to an extra key`);
    const result = await checkRole({
      fetch: deps.fetch,
      baseUrl: deps.baseUrl(),
      role,
      model,
      keyName: route.name,
      value: route.value,
    });
    if (!result.ok) return failed(name, `${checkLine(result)}\nThe model is not saved.`);
    await deps.saveModel(role, model);
    return { text: `${checkLine(result)}\nThe ${role} model is saved.`, status: 'ok' };
  }

  async function dispatch(name: string, args: Record<string, unknown>, dialog: Dialog | null): Promise<Answer> {
    switch (name) {
      case 'keys.core.add':
        return addCore(name, args, dialog);
      case 'keys.core.remove':
        return removeCore(name, args);
      case 'keys.core.list':
        return listCore();
      case 'keys.extra.add':
        return addExtra(name, args, dialog);
      case 'keys.extra.remove':
        store.removeExtra(text(args.name));
        return { text: 'The extra key is removed.', status: 'ok' };
      case 'keys.extra.list':
        return listExtra();
      case 'keys.bind':
        store.bind(text(args.role), text(args.name));
        return {
          text: `The ${text(args.role)} role goes out on key ${text(args.name)} alone. Prove it with /keys check ${text(args.role)}.`,
          status: 'ok',
        };
      case 'keys.unbind':
        store.unbind(text(args.role));
        return { text: `The ${text(args.role)} role is back on the core keys.`, status: 'ok' };
      case 'keys.check': {
        const role = text(args.role);
        if (roleGroup(role) !== 'base') return invalid(name, new KeysError('unknown-role').message);
        return checkOne(name, role);
      }
      case 'model.set':
        return setModel(name, args);
      default:
        return invalid(name, 'no such command; type /help');
    }
  }

  return {
    async run(name, args, dialog) {
      try {
        return await dispatch(name, args, dialog);
      } catch (err) {
        if (err instanceof KeysError) return invalid(name, err.message);
        log.warn('keys: command failed', { command: name, error: err });
        return failed(name, err instanceof Error ? err.message : 'it did not go through');
      }
    },
  };
}
