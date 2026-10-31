// How the interfaces run beside the core, read from the `interfaces` settings. `interfaceMode` decides whether the
// entry (src/index.js) starts the interfaces in the core's process (`inprocess`) or leaves them to their systemd units
// (`units`), and refuses any other value, because a guess would start the persona with no interface or with a second
// platform client beside a running unit. `interfaceEnabled` is the owner's switch of one interface
// (`interfaces.<name>.enabled`), which the link reads at every `hello` (src/core.js), and `drainMs` is how long a
// disable lets the actions in flight finish (src/interface/link.ts#createInterfaceLinks).

/** The ways the interfaces run. */
export const INTERFACE_MODES = ['inprocess', 'units'] as const;
export type InterfaceMode = (typeof INTERFACE_MODES)[number];

/** config.json's `interfaces.drainMs`, for a config that lacks it. */
const DRAIN_MS = 10_000;

/** The keys of `interfaces` that are settings of all interfaces, never an interface's name. */
export const SHARED_KEYS: ReadonlySet<string> = new Set(['mode', 'drainMs']);

type Settings = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Settings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const interfacesOf = (config: Settings): Settings => (isObject(config.interfaces) ? config.interfaces : {});

const isMode = (value: unknown): value is InterfaceMode =>
  typeof value === 'string' && (INTERFACE_MODES as ReadonlyArray<string>).includes(value);

/** `interfaces.mode`, or a throw naming both modes when it holds anything else (a missing key included). */
export function interfaceMode(config: Settings): InterfaceMode {
  const mode = interfacesOf(config).mode;
  if (!isMode(mode)) {
    throw new Error(
      `interfaces.mode is ${JSON.stringify(mode) ?? 'not set'}; set it to "${INTERFACE_MODES.join('" or "')}" in config.local.json`
    );
  }
  return mode;
}

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

/** `interfaces.drainMs` when it is a non-negative number, else config.json's default. */
export function drainMs(config: Settings): number {
  const value = interfacesOf(config).drainMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DRAIN_MS;
}
