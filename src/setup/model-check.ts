// The recorded check of the core model: which selection the last `/model set core` or `/keys check core` tested and what
// the provider said, kept in `<data>/setup/core-check.json` so a launch's readiness needs no model request. A check answers
// for its own selection, so a model changed since reads as stale in src/setup/readiness.ts. The core writes the record
// (src/core.ts) and a launch reads it with no core. A record that cannot be read is no check at all.

import fs from 'node:fs';
import path from 'node:path';
import { directSelectionOf, roleModel } from '../llm/roles.ts';

export type CoreCheck = { selection: string; ok: boolean; code: string | null; at: number };

const fileOf = (dataDir: string): string => path.join(dataDir, 'setup', 'core-check.json');

/** The selection the settings name now, null while the core role has no model; the core role has no subharness path. */
export function coreSelection(config: unknown): string | null {
  const model = roleModel(config, 'core');
  return typeof model === 'string' && model !== '' ? directSelectionOf(model) : null;
}

/** Writes the record through a temporary file renamed into place, so a reader never sees half of it. */
export function recordCoreCheck(dataDir: string, check: CoreCheck): void {
  const file = fileOf(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(check)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function readCoreCheck(dataDir: string): CoreCheck | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const { selection, ok, code, at } = parsed as Record<string, unknown>;
  if (typeof selection !== 'string' || typeof ok !== 'boolean' || typeof at !== 'number') return null;
  if (code !== null && typeof code !== 'string') return null;
  return { selection, ok, code, at };
}
