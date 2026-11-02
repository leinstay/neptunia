// The settings of her self-development (docs/selfdev.md): `selfdev.mode`, `selfdev.base`, `selfdev.checkout` and
// `selfdev.repository`, read from a config at the moment of use.

import path from 'node:path';

/** `approve`: every pull request waits for the owner's merge. `auto`: the engine merges when CI is green. */
export type SelfdevMode = 'approve' | 'auto';
export type SelfdevSettings = {
  mode: SelfdevMode;
  base: string;
  /** the dev checkout `neptunia setup` renders the selfdev units over; null renders none */
  checkout: string | null;
  /** `owner/name`, the repository her pull requests open against; null while unset */
  repository: string | null;
};

const BASE_DEFAULT = 'main';
/** `owner/name` as GitHub spells it: two non-empty segments of letters, digits, `.`, `_` and `-`. */
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** `value` when it is `owner/name`, else null. */
export function repositoryName(value: unknown): string | null {
  return typeof value === 'string' && REPOSITORY.test(value) ? value : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * `selfdev.mode` (anything but `auto` is `approve`), `selfdev.base` (default `main`) and `selfdev.checkout` (an absolute
 * path, else null: systemd refuses a relative `WorkingDirectory`) and `selfdev.repository` (`owner/name`, else null).
 */
export function selfdevSettings(config: unknown): SelfdevSettings {
  const section = isRecord(config) && isRecord(config.selfdev) ? config.selfdev : {};
  const base = typeof section.base === 'string' && section.base !== '' ? section.base : BASE_DEFAULT;
  const checkout = typeof section.checkout === 'string' && path.isAbsolute(section.checkout) ? section.checkout : null;
  const repository = repositoryName(section.repository);
  return { mode: section.mode === 'auto' ? 'auto' : 'approve', base, checkout, repository };
}
