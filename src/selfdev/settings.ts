// The settings of her self-development (docs/selfdev.md): `selfdev.mode` and `selfdev.base`, read from a config at the
// moment of use.

/** `approve`: every pull request waits for the owner's merge. `auto`: the engine merges when CI is green. */
export type SelfdevMode = 'approve' | 'auto';
export type SelfdevSettings = { mode: SelfdevMode; base: string };

const BASE_DEFAULT = 'main';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** `selfdev.mode` (anything but `auto` is `approve`) and `selfdev.base` (default `main`). */
export function selfdevSettings(config: unknown): SelfdevSettings {
  const section = isRecord(config) && isRecord(config.selfdev) ? config.selfdev : {};
  const base = typeof section.base === 'string' && section.base !== '' ? section.base : BASE_DEFAULT;
  return { mode: section.mode === 'auto' ? 'auto' : 'approve', base };
}
