// What the core reads of the `interfaces` settings. `interfaceEnabled` is the owner's switch of one interface
// (`interfaces.<name>.enabled`), which the link reads at every `hello` (src/core.ts), and `drainMs` is how long a
// disable lets the actions in flight finish (src/interface/link.ts#createInterfaceLinks).

/** config/config.json's `interfaces.drainMs`, for a config that lacks it. */
const DRAIN_MS = 10_000;

/** The keys of `interfaces` that are settings of all interfaces, never an interface's name. */
export const SHARED_KEYS: ReadonlySet<string> = new Set(['drainMs']);

type Settings = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Settings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const interfacesOf = (config: Settings): Settings => (isObject(config.interfaces) ? config.interfaces : {});

/** Whether interface `name` may connect: true unless `interfaces.<name>.enabled` is false. */
export function interfaceEnabled(config: Settings, name: string): boolean {
  const entry = interfacesOf(config)[name];
  return !(isObject(entry) && entry.enabled === false);
}

/** The interfaces the settings name (`interfaces.<name>` objects), in the order the file has them. */
export function configuredInterfaces(config: Settings): Array<string> {
  return Object.entries(interfacesOf(config))
    .filter(([key, value]) => !SHARED_KEYS.has(key) && isObject(value))
    .map(([key]) => key);
}

/** `interfaces.drainMs` when it is a non-negative number, else config/config.json's default. */
export function drainMs(config: Settings): number {
  const value = interfacesOf(config).drainMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DRAIN_MS;
}
