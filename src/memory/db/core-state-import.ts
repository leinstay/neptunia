// Explicit legacy core-state import for migration tools. Existing unit writers map guild values in one transaction.

import fs from 'node:fs';
import path from 'node:path';
import { hasStorageUnits, ensureUnit } from './storage-units.ts';
import { legacyStorageKey } from './paths.ts';

import { errorFields } from '../../error-fields.ts';
import { isPlainObject } from './map/common.ts';
import { applyUnitWrite, noteUnit } from './unit-write.ts';
import { dbOf } from './types.ts';
import type { MemoryHandle, Row } from './types.ts';

const ROOT_NAMES = ['state', 'usage', 'metrics'] as const;
const GUILD_NAMES = ['inner', 'missed', 'participation', 'gifs', 'media'] as const;
type Source = { owner: string; rootKind?: string };

/** The supported source files, with root values kept separately from mapped guild units. */
function sourcesIn(dataDir: string): Array<Source> {
  const sources: Array<Source> = ROOT_NAMES.map((name) => ({ owner: `${name}.json`, rootKind: name }));
  let communities: Array<fs.Dirent>;
  try {
    communities = fs.readdirSync(path.join(dataDir, 'guilds'), { withFileTypes: true });
  } catch (error) {
    if (errorFields(error).code === 'ENOENT') return sources;
    throw error;
  }
  for (const community of communities
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name)))
    for (const name of GUILD_NAMES) sources.push({ owner: `guilds/${community.name}/${name}.json` });
  return sources;
}

/** Missing sources contribute nothing. Invalid JSON objects refuse the whole import. */
function readState(file: string): Row | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (errorFields(error).code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('CORE_STATE_JSON'), { code: 'CORE_STATE_JSON' });
  }
  if (!isPlainObject(value)) throw Object.assign(new Error('CORE_STATE_JSON'), { code: 'CORE_STATE_JSON' });
  return value;
}

/** Copies unimported JSON without changing source files or selecting live readers and writers. */
export function importCoreJsonState(
  handle: MemoryHandle,
  { dataDir, now = Date.now() }: { dataDir: string; now?: number }
): { imported: number } {
  return handle.transaction(() => {
    const db = dbOf(handle);
    // The enclosing import owns the transaction, including each unit writer's values and marker.
    const units: MemoryHandle = { ...handle, transaction: (run) => run() };
    const known = db.prepare('SELECT 1 FROM files WHERE path = ?');
    const root = db.prepare(
      'INSERT OR IGNORE INTO operational (kind, owner, value, owner_file) VALUES (?, ?, ?, NULL)'
    );
    const at = new Date(now).toISOString();
    let imported = 0;
    for (const source of sourcesIn(dataDir)) {
      if (known.get(source.owner)) continue;
      const value = readState(path.join(dataDir, source.owner));
      if (value === undefined) continue;
      if (hasStorageUnits(db)) {
        const key = legacyStorageKey(source.owner);
        applyUnitWrite(units, { op: 'value', key, value, now });
        const unitId = ensureUnit(db, key);
        db.prepare('INSERT OR IGNORE INTO legacy_unit_aliases(path,unit_id) VALUES (?,?)').run(source.owner, unitId);
        db.prepare('INSERT OR IGNORE INTO files(path,kind,synced_at) VALUES (?,?,?)').run(
          source.owner,
          'core-state-import',
          at
        );
      } else if (source.rootKind) {
        root.run(source.rootKind, source.owner, JSON.stringify(value));
        noteUnit(db, source.owner, 'core-state-import', { at });
      } else applyUnitWrite(units, { kind: 'unit', op: 'value', owner: source.owner, value, now });
      imported += 1;
    }
    return { imported };
  });
}
