// The settings of the plugins, read from the live config at the moment of use: `plugins.<name>.enabled` is the owner's
// switch of one plugin (written by `/plugins enable` and `/plugins disable`, src/plugins/control.ts) and
// `plugins.callDeadlineMs` is how long a call to a plugin's tool may take before the core answers that the plugin did
// not answer (src/plugins/link.ts).

type Settings = Readonly<Record<string, unknown>>;

/** config/config.json's `plugins.callDeadlineMs`, for a config that lacks it. */
const CALL_DEADLINE_MS = 30_000;

/** The key of `plugins` that is a setting of all plugins, never a plugin's name. */
const SHARED_KEY = 'callDeadlineMs';

const isObject = (value: unknown): value is Settings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const pluginsOf = (config: Settings): Settings => (isObject(config.plugins) ? config.plugins : {});

/** Whether plugin `name` is on: `plugins.<name>.enabled` is exactly true. A plugin is off until the owner turns it on. */
export function pluginEnabled(config: Settings, name: string): boolean {
  if (name === SHARED_KEY) return false;
  const entry = pluginsOf(config)[name];
  return isObject(entry) && entry.enabled === true;
}

/** `plugins.callDeadlineMs` when it is a positive number, else config/config.json's default. */
export function pluginCallDeadlineMs(config: Settings): number {
  const value = pluginsOf(config)[SHARED_KEY];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : CALL_DEADLINE_MS;
}
