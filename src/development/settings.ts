// The settings of the development worker (docs/selfimprovement.md): `development.thinkerTurns`,
// `development.lookEveryMs` and `development.startedAt`, read from a config at the moment of use, and the one write of
// the worker to the local settings, its boundary at its first start.

import { localConfigPath } from '../config/files.ts';
import { readLocalConfig, setPath, writeLocalConfig } from '../tools/impl/shared.ts';

export type DevelopmentSettings = {
  /** the most thinker turns on a task before it blocks */
  thinkerTurns: number;
  /** how often the worker looks at GitHub while a pull request is watched (ms) */
  lookEveryMs: number;
  /** the moment the worker first started, as an ISO time; a task approved before it waits for the owner */
  startedAt: string | null;
};

const THINKER_TURNS_DEFAULT = 12;
const LOOK_EVERY_MS_DEFAULT = 120_000;
/** GitHub allows 5,000 requests an hour; one look is one request per watched pull request. */
const LOOK_EVERY_MS_MIN = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** `development.*` of a config; a value that means nothing reads as the default. */
export function developmentSettings(config: unknown): DevelopmentSettings {
  const section = isRecord(config) && isRecord(config.development) ? config.development : {};
  const { thinkerTurns, lookEveryMs, startedAt } = section;
  return {
    thinkerTurns:
      typeof thinkerTurns === 'number' && Number.isInteger(thinkerTurns) && thinkerTurns >= 1
        ? thinkerTurns
        : THINKER_TURNS_DEFAULT,
    lookEveryMs:
      typeof lookEveryMs === 'number' && Number.isFinite(lookEveryMs) && lookEveryMs >= LOOK_EVERY_MS_MIN
        ? lookEveryMs
        : LOOK_EVERY_MS_DEFAULT,
    startedAt: typeof startedAt === 'string' && Number.isFinite(Date.parse(startedAt)) ? startedAt : null,
  };
}

/**
 * The boundary in force: `development.startedAt` of `config`, else `now`, written into the local settings under
 * `privateDir` first. A worker that cannot write it throws and never starts, so it never runs without a boundary.
 */
export function ensureStartedAt(privateDir: string, config: unknown, now: number): string {
  const stored = developmentSettings(config).startedAt;
  if (stored !== null) return stored;
  const startedAt = new Date(now).toISOString();
  const file = localConfigPath(privateDir);
  writeLocalConfig(file, setPath(readLocalConfig(file), ['development', 'startedAt'], startedAt));
  return startedAt;
}
