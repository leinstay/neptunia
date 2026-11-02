// The settings of her self-improvement's hands (docs/selfimprovement.md): `selfimprovement.enabled`,
// `selfimprovement.mode`, `selfimprovement.base`, `selfimprovement.checkout` and `selfimprovement.repository`, read
// from a config at the moment of use. The wake's own keys (`everyDays`, `failuresPerShape`) are read by
// src/behavior/inner/settings.ts.

import path from 'node:path';

/** `approve`: every pull request waits for the owner's merge. `auto`: the engine merges when CI is green. */
export type SelfimprovementMode = 'approve' | 'auto';
export type SelfimprovementSettings = {
  /** false only when `selfimprovement.enabled` says so: the beat then does nothing */
  enabled: boolean;
  mode: SelfimprovementMode;
  base: string;
  /** the dev checkout `neptunia setup` renders the selfimprovement units over; null renders none */
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
 * `selfimprovement.enabled` (anything but `false` is on), `selfimprovement.mode` (anything but `auto` is `approve`),
 * `selfimprovement.base` (default `main`), `selfimprovement.checkout` (an absolute path, else null: systemd refuses a
 * relative `WorkingDirectory`) and `selfimprovement.repository` (`owner/name`, else null).
 */
export function selfimprovementSettings(config: unknown): SelfimprovementSettings {
  const section = isRecord(config) && isRecord(config.selfimprovement) ? config.selfimprovement : {};
  const base = typeof section.base === 'string' && section.base !== '' ? section.base : BASE_DEFAULT;
  const checkout = typeof section.checkout === 'string' && path.isAbsolute(section.checkout) ? section.checkout : null;
  const repository = repositoryName(section.repository);
  return {
    enabled: section.enabled !== false,
    mode: section.mode === 'auto' ? 'auto' : 'approve',
    base,
    checkout,
    repository,
  };
}
