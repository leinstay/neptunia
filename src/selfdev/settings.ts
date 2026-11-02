// The settings of her self-development (docs/selfdev.md): `selfdev.mode`, `selfdev.base` and `selfdev.checkout`, read
// from a config at the moment of use.

import path from 'node:path';

/** `approve`: every pull request waits for the owner's merge. `auto`: the engine merges when CI is green. */
export type SelfdevMode = 'approve' | 'auto';
export type SelfdevSettings = {
  mode: SelfdevMode;
  base: string;
  /** the dev checkout `neptunia setup` renders the selfdev units over; null renders none */
  checkout: string | null;
};

const BASE_DEFAULT = 'main';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * `selfdev.mode` (anything but `auto` is `approve`), `selfdev.base` (default `main`) and `selfdev.checkout` (an absolute
 * path, else null: systemd refuses a relative `WorkingDirectory`).
 */
export function selfdevSettings(config: unknown): SelfdevSettings {
  const section = isRecord(config) && isRecord(config.selfdev) ? config.selfdev : {};
  const base = typeof section.base === 'string' && section.base !== '' ? section.base : BASE_DEFAULT;
  const checkout = typeof section.checkout === 'string' && path.isAbsolute(section.checkout) ? section.checkout : null;
  return { mode: section.mode === 'auto' ? 'auto' : 'approve', base, checkout };
}
